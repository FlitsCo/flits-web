#!/usr/bin/env node
/**
 * Regenerates sitemap.xml from the HTML files in this repository.
 *
 *   node scripts/generate-sitemap.mjs           write sitemap.xml
 *   node scripts/generate-sitemap.mjs --check   fail if sitemap.xml is stale
 *
 * A page is included when it is a .html file outside the ignored directories
 * and does not ask robots not to index it. Its URL comes from the page's own
 * <link rel="canonical">, so the sitemap and the canonical tags can never
 * disagree; pages without one fall back to the path Vercel serves them at.
 * <lastmod> is the date of the last commit that touched the file.
 *
 * .github/workflows/sitemap.yml runs this on every push, so adding a page is
 * enough — the sitemap follows on its own.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SITEMAP = join(ROOT, 'sitemap.xml');
const SITE_ORIGIN = 'https://flits.so';

/** Directories never scanned for pages. */
const IGNORED_DIRS = new Set(['.git', '.github', 'node_modules', 'assets', 'scripts']);

/**
 * Order of the entries in the sitemap. A trailing `*` matches every URL one
 * level below that prefix; those are sorted newest first by published date.
 * URLs matching nothing here are appended at the end, so a new page always
 * lands in the sitemap even if nobody updates this list.
 */
const URL_ORDER = ['/', '/principal', '/notes', '/notes/*', '/legal', '/privacy'];

const MONTHS = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];

async function findHtmlFiles(dir) {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      found.push(...(await findHtmlFiles(join(dir, entry.name))));
    } else if (entry.isFile() && entry.name.endsWith('.html')) {
      found.push(join(dir, entry.name));
    }
  }
  return found;
}

/** True when the page asks robots to keep it out of the index. */
function isNoIndex(html) {
  const robots = html.match(/<meta[^>]+name=["']robots["'][^>]*>/gi) ?? [];
  return robots.some((tag) => /noindex/i.test(tag));
}

/** The URL a page declares for itself, if it declares one. */
function canonicalUrl(html) {
  const tag = html.match(/<link[^>]+rel=["']canonical["'][^>]*>/i)?.[0];
  return tag?.match(/href=["']([^"']+)["']/i)?.[1] ?? null;
}

/**
 * Where Vercel serves a file, given `cleanUrls` and `trailingSlash: false`
 * in vercel.json: notes/founding-flits.html -> /notes/founding-flits.
 */
function urlFromPath(file) {
  const path = relative(ROOT, file).split(/[\\/]/).join('/').replace(/\.html$/, '');
  if (path === 'index') return `${SITE_ORIGIN}/`;
  return `${SITE_ORIGIN}/${path.replace(/\/index$/, '')}`;
}

/** Publication date shown on the page ("August 2026"), used only for ordering. */
function publishedAt(html) {
  const eyebrow = html.match(/<p[^>]+class=["'][^"']*eyebrow[^"']*["'][^>]*>([\s\S]*?)<\/p>/i)?.[1];
  const match = (eyebrow ?? '').match(new RegExp(`(${MONTHS.join('|')})\\s+(\\d{4})`, 'i'));
  if (!match) return null;
  const month = String(MONTHS.indexOf(match[1].toLowerCase()) + 1).padStart(2, '0');
  return `${match[2]}-${month}`;
}

/** Date of the last commit touching a file, as YYYY-MM-DD. */
function lastCommitDate(file) {
  try {
    const out = execFileSync(
      'git',
      ['log', '-1', '--format=%cs', '--', relative(ROOT, file)],
      { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
    return /^\d{4}-\d{2}-\d{2}$/.test(out) ? out : null;
  } catch {
    return null; // No git history available: emit the entry without <lastmod>.
  }
}

function matchesPattern(url, pattern) {
  const path = url.slice(SITE_ORIGIN.length) || '/';
  if (!pattern.endsWith('*')) return path === pattern;
  const prefix = pattern.slice(0, -1);
  return path.startsWith(prefix) && !path.slice(prefix.length).includes('/');
}

/** Applies URL_ORDER, newest first inside a wildcard group, unknowns last. */
function sortPages(pages) {
  const remaining = [...pages];
  const ordered = [];

  for (const pattern of URL_ORDER) {
    const group = remaining.filter((page) => matchesPattern(page.url, pattern));
    for (const page of group) remaining.splice(remaining.indexOf(page), 1);
    group.sort((a, b) => {
      const date = (b.published ?? b.lastmod ?? '').localeCompare(a.published ?? a.lastmod ?? '');
      return date !== 0 ? date : a.url.localeCompare(b.url);
    });
    ordered.push(...group);
  }

  remaining.sort((a, b) => a.url.localeCompare(b.url));
  return [...ordered, ...remaining];
}

function renderSitemap(pages) {
  const entries = pages.map((page) => {
    const lastmod = page.lastmod ? `\n    <lastmod>${page.lastmod}</lastmod>` : '';
    return `  <url>\n    <loc>${page.url}</loc>${lastmod}\n  </url>`;
  });
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...entries,
    '</urlset>',
    '',
  ].join('\n');
}

async function collectPages() {
  const pages = [];
  const skipped = [];

  for (const file of await findHtmlFiles(ROOT)) {
    const html = readFileSync(file, 'utf8');
    const name = relative(ROOT, file);

    if (isNoIndex(html)) {
      skipped.push(`${name} (noindex)`);
      continue;
    }

    const declared = canonicalUrl(html);
    const derived = urlFromPath(file);
    if (declared && !declared.startsWith(`${SITE_ORIGIN}/`)) {
      throw new Error(`${name}: canonical "${declared}" is not on ${SITE_ORIGIN}`);
    }

    pages.push({
      file: name,
      url: declared ?? derived,
      lastmod: lastCommitDate(file),
      published: publishedAt(html),
    });
  }

  const seen = new Map();
  for (const page of pages) {
    if (seen.has(page.url)) {
      throw new Error(`${page.file} and ${seen.get(page.url)} both claim ${page.url}`);
    }
    seen.set(page.url, page.file);
  }

  return { pages: sortPages(pages), skipped };
}

const { pages, skipped } = await collectPages().catch((error) => {
  console.error(`sitemap: ${error.message}`);
  process.exit(1);
});
const expected = renderSitemap(pages);
const current = (() => {
  try {
    return readFileSync(SITEMAP, 'utf8');
  } catch {
    return null;
  }
})();

const unordered = pages
  .filter((page) => !URL_ORDER.some((pattern) => matchesPattern(page.url, pattern)))
  .map((page) => page.url);

if (process.argv.includes('--check')) {
  if (current === expected) {
    console.log(`sitemap.xml is up to date (${pages.length} URLs).`);
    process.exit(0);
  }
  console.error('sitemap.xml is out of date. Run: node scripts/generate-sitemap.mjs');
  process.exit(1);
}

if (current === expected) {
  console.log(`sitemap.xml unchanged (${pages.length} URLs).`);
} else {
  writeFileSync(SITEMAP, expected);
  console.log(`sitemap.xml written with ${pages.length} URLs.`);
}

for (const entry of skipped) console.log(`skipped ${entry}`);
if (unordered.length) {
  console.log(`appended at the end (not listed in URL_ORDER): ${unordered.join(', ')}`);
}
