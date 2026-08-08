import { XMLParser } from "fast-xml-parser";
import { UA } from "./http.js";
import { tokenize } from "./text.js";
import { safeFetch } from "./safeFetch.js";

const parser = new XMLParser({ ignoreAttributes: false });

function normalizeDomain(domain) {
  let d = (domain || "").trim();
  if (!/^https?:\/\//i.test(d)) d = "https://" + d;
  return new URL(d);
}

async function tryFetch(url) {
  try {
    const res = await safeFetch(url, {
      headers: { "User-Agent": UA, Accept: "text/xml,application/xml,*/*" },
    });
    if (!res.ok) return null;
    return res.text;
  } catch {
    return null;
  }
}

/** Find candidate sitemap URLs from robots.txt + common locations. */
async function discoverSitemaps(origin) {
  const found = new Set();
  const robots = await tryFetch(new URL("/robots.txt", origin).href);
  if (robots) {
    for (const line of robots.split("\n")) {
      const m = line.match(/^\s*sitemap:\s*(\S+)/i);
      if (m) found.add(m[1].trim());
    }
  }
  found.add(new URL("/sitemap.xml", origin).href);
  found.add(new URL("/sitemap_index.xml", origin).href);
  return [...found];
}

/**
 * Pure XML parsing, split out from collectUrls so it's testable without a
 * network fetch. Returns null on unparseable XML; otherwise the sitemap-index
 * entries and/or page URLs found (a sitemap file has one or the other, never
 * meaningfully both).
 */
export function parseSitemapXml(xml) {
  let doc;
  try {
    doc = parser.parse(xml);
  } catch {
    return null;
  }
  const sitemapUrls = doc.sitemapindex?.sitemap
    ? [].concat(doc.sitemapindex.sitemap)
        .map((e) => e.loc)
        .filter(Boolean)
    : [];
  const pageUrls = doc.urlset?.url
    ? [].concat(doc.urlset.url)
        .map((e) => e.loc)
        .filter(Boolean)
    : [];
  return { sitemapUrls, pageUrls };
}

/** Recursively resolve a sitemap (handles sitemap-index files). */
async function collectUrls(sitemapUrl, out, depth = 0) {
  if (depth > 3 || out.size > 8000) return;
  const xml = await tryFetch(sitemapUrl);
  if (!xml) return;
  const parsed = parseSitemapXml(xml);
  if (!parsed) return;

  if (parsed.sitemapUrls.length) {
    // Bounded-concurrency worker pool (same pattern as fetchTitles in
    // lib/pageMeta.js): each worker pulls the next child sitemap URL off a
    // shared counter, re-checking the size cap before every fetch it starts
    // so concurrent workers can't overshoot it.
    const locs = parsed.sitemapUrls;
    let i = 0;
    async function worker() {
      while (i < locs.length) {
        if (out.size > 8000) return;
        const loc = locs[i++];
        await collectUrls(loc, out, depth + 1);
      }
    }
    await Promise.all(Array.from({ length: Math.min(5, locs.length) }, worker));
    return;
  }

  for (const loc of parsed.pageUrls) out.add(loc);
}

/**
 * Fetch every URL in a domain's sitemap(s), once.
 * `cache` (optional Map<domain, Promise<{origin,urls}>>) lets callers that
 * process multiple articles against the same domain (e.g. batch runs) share
 * one crawl instead of re-fetching robots.txt + the whole sitemap per article.
 */
export function getAllSitemapUrls(domain, { cache } = {}) {
  if (cache?.has(domain)) return cache.get(domain);

  const promise = (async () => {
    const origin = normalizeDomain(domain).origin;
    const sitemaps = await discoverSitemaps(origin);
    const urlSet = new Set();
    for (const sm of sitemaps) {
      await collectUrls(sm, urlSet);
      if (urlSet.size > 8000) break;
    }
    return { origin, urls: [...urlSet] };
  })();

  cache?.set(domain, promise);
  // Fetch failures resolve to an empty list rather than rejecting (see
  // tryFetch), so a transient blip would otherwise be memoized as permanent
  // for the rest of a batch run. Don't keep a result that found nothing —
  // let the next article that needs this domain retry fresh.
  promise.then((result) => {
    if (result.urls.length === 0 && cache?.get(domain) === promise) cache.delete(domain);
  });
  return promise;
}

/** Score a pre-decoded, lowercased slug against a set of tokens by overlap. */
export function scoreSlug(slug, tokens) {
  let score = 0;
  for (const t of tokens) if (slug.includes(t)) score += 1;
  return score;
}

/**
 * Normalize a URL to host+path for comparison so a submitted URL still
 * matches its sitemap-canonical form even when they differ in scheme,
 * "www.", trailing slash, or query/fragment.
 */
export function normalizeUrlForComparison(u) {
  try {
    const url = new URL((u || "").trim());
    return (url.hostname.replace(/^www\./, "") + url.pathname.replace(/\/+$/, "")).toLowerCase();
  } catch {
    return (u || "").trim().toLowerCase().replace(/\/+$/, "");
  }
}

/**
 * Anchor-first, multi-term candidate discovery.
 * `termGroups` is an array of search phrases (entities, topics, synonyms). For
 * each group we keep the top `perTerm` URLs that genuinely match (score > 0),
 * then union across groups. This surfaces topically diverse pages instead of
 * only slug look-alikes of one keyword. No score-0 padding — quality over count.
 *
 * @returns {{origin, total, candidates:string[]}}
 */
export async function discoverCandidates(
  domain,
  termGroups,
  { perTerm = 6, cap = 40, exclude = [], cache } = {}
) {
  const { origin, urls: allUrls } = await getAllSitemapUrls(domain, { cache: cache?.sitemap });
  if (allUrls.length === 0) return { origin, total: 0, candidates: [] };

  // Never recommend the article's own page (or other excluded URLs).
  const excludeSet = new Set(exclude.map(normalizeUrlForComparison));
  const urls = allUrls.filter((u) => !excludeSet.has(normalizeUrlForComparison(u)));

  // Decode + lowercase each URL once up front instead of inside the per-term
  // loop below, where the same URL would otherwise be re-decoded for every
  // search term (dozens of times per run against a large sitemap).
  const slugOf = new Map(urls.map((u) => [u, decodeURIComponent(u).toLowerCase()]));

  // Track, per URL, its best single-term score and how many distinct terms hit
  // it. Ranking by these pushes genuinely-relevant pages to the top and lets us
  // trim the long tail of weak, noisy matches before the model ever sees them.
  const best = new Map(); // url -> { score, hits }

  for (const term of termGroups) {
    const tokens = tokenize(term);
    if (tokens.length === 0) continue;
    const matches = urls
      .map((u) => ({ url: u, score: scoreSlug(slugOf.get(u), tokens) }))
      .filter((m) => m.score > 0)
      .sort((a, b) => b.score - a.score || a.url.length - b.url.length)
      .slice(0, perTerm);
    for (const m of matches) {
      const prev = best.get(m.url) || { score: 0, hits: 0 };
      best.set(m.url, { score: Math.max(prev.score, m.score), hits: prev.hits + 1 });
    }
  }

  const candidates = [...best.entries()]
    .sort((a, b) => b[1].hits - a[1].hits || b[1].score - a[1].score || a[0].length - b[0].length)
    .slice(0, cap)
    .map(([url]) => url);

  return { origin, total: allUrls.length, candidates };
}
