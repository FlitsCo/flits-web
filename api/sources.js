// Resolver for n.flits.so/<slug> — the short links Nome sends instead of a
// long list of source URLs.
//
// A research reply used to end with three or four full URLs, each wrapping over
// several lines on a phone and pushing the answer off screen. Nome now stores
// the set and sends one short link; this turns that link back into the sources.
//
// One source redirects straight through, so a single-source link behaves
// exactly like the URL it stands for. Several render a small page listing the
// real addresses — the URLs are never disguised, so anything is inspectable
// before it is followed.
//
// Reads with the anon key against a table whose only policy is public SELECT.
// There is no service_role key here and no write path: this endpoint cannot
// mint links, only resolve them.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

const SLUG_RE = /^[a-z2-9]{4,16}$/;

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Only http(s) is ever emitted as a link target, so a stored value cannot
// become a javascript: or data: URL in the rendered page.
function safeUrl(raw) {
  try {
    const u = new URL(raw);
    return u.protocol === "http:" || u.protocol === "https:" ? u.toString() : null;
  } catch {
    return null;
  }
}

function hostOf(raw) {
  try {
    return new URL(raw).host.replace(/^www\./, "");
  } catch {
    return raw;
  }
}

function page({ title, heading, body, status }) {
  return {
    status,
    html: `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: dark light; }
  body { margin:0; padding:2.5rem 1.25rem; background:#0b0b0c; color:#f4f4f5;
         font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,sans-serif;
         display:flex; justify-content:center; }
  main { width:100%; max-width:34rem; }
  h1 { font-size:.8rem; font-weight:600; letter-spacing:.08em; text-transform:uppercase;
       color:#8b8b93; margin:0 0 1.5rem; }
  ol { list-style:none; margin:0; padding:0; }
  li { border-top:1px solid #232326; }
  li:last-child { border-bottom:1px solid #232326; }
  a.src { display:block; padding:1rem 0; color:inherit; text-decoration:none; }
  a.src:hover .t { text-decoration:underline; }
  .t { display:block; font-weight:500; }
  .u { display:block; margin-top:.2rem; font-size:.82rem; color:#7c7c85;
       overflow-wrap:anywhere; }
  p { color:#8b8b93; }
  footer { margin-top:2rem; font-size:.78rem; color:#5c5c64; }
  @media (prefers-color-scheme: light) {
    body { background:#fff; color:#111; } li { border-color:#e6e6e9; }
    .u { color:#6b7280; } h1,footer,p { color:#6b7280; }
  }
</style>
</head><body><main>
<h1>${escapeHtml(heading)}</h1>
${body}
<footer>via Nome</footer>
</main></body></html>`,
  };
}

export default async function handler(req, res) {
  const slug = String(req.query.slug ?? "").toLowerCase().trim();

  if (!SLUG_RE.test(slug)) {
    const { html } = page({
      title: "Not found",
      heading: "Not found",
      body: "<p>That link doesn’t look right.</p>",
      status: 404,
    });
    res.status(404).setHeader("Content-Type", "text/html; charset=utf-8");
    return res.send(html);
  }

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    res.status(500).setHeader("Content-Type", "text/html; charset=utf-8");
    return res.send(
      page({
        title: "Not configured",
        heading: "Not configured",
        body: "<p>This resolver is missing its database configuration.</p>",
        status: 500,
      }).html,
    );
  }

  let row = null;
  try {
    const url =
      `${SUPABASE_URL}/rest/v1/source_links` +
      `?slug=eq.${encodeURIComponent(slug)}&select=urls,titles&limit=1`;
    const r = await fetch(url, {
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` },
    });
    if (r.ok) {
      const rows = await r.json();
      row = Array.isArray(rows) ? rows[0] : null;
    }
  } catch {
    // fall through to the not-found page rather than surfacing an internal error
  }

  const urls = (row?.urls ?? []).map(safeUrl).filter(Boolean);
  const titles = row?.titles ?? [];

  if (urls.length === 0) {
    res.status(404).setHeader("Content-Type", "text/html; charset=utf-8");
    return res.send(
      page({
        title: "Not found",
        heading: "Not found",
        body: "<p>This link has expired or never existed.</p>",
        status: 404,
      }).html,
    );
  }

  // A single source behaves exactly like the URL it replaces.
  if (urls.length === 1) {
    res.setHeader("Cache-Control", "public, max-age=300");
    return res.redirect(302, urls[0]);
  }

  const items = urls
    .map((u, i) => {
      const label = (titles[i] || "").trim() || hostOf(u);
      return `<li><a class="src" href="${escapeHtml(u)}" rel="noopener noreferrer nofollow">
  <span class="t">${escapeHtml(label)}</span>
  <span class="u">${escapeHtml(u)}</span>
</a></li>`;
    })
    .join("\n");

  res.status(200).setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "public, max-age=300");
  return res.send(
    page({
      title: `${urls.length} sources`,
      heading: `${urls.length} sources`,
      body: `<ol>${items}</ol>`,
      status: 200,
    }).html,
  );
}
