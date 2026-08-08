import { XMLParser } from "fast-xml-parser";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0 Safari/537.36";

const parser = new XMLParser({ ignoreAttributes: false });

function normalizeDomain(domain) {
  let d = (domain || "").trim();
  if (!/^https?:\/\//i.test(d)) d = "https://" + d;
  return new URL(d);
}

async function tryFetch(url) {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "text/xml,application/xml,*/*" },
      redirect: "follow",
    });
    if (!res.ok) return null;
    return await res.text();
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

/** Recursively resolve a sitemap (handles sitemap-index files). */
async function collectUrls(sitemapUrl, out, depth = 0) {
  if (depth > 3 || out.size > 8000) return;
  const xml = await tryFetch(sitemapUrl);
  if (!xml) return;
  let doc;
  try {
    doc = parser.parse(xml);
  } catch {
    return;
  }

  if (doc.sitemapindex?.sitemap) {
    const entries = [].concat(doc.sitemapindex.sitemap);
    for (const e of entries) {
      if (e.loc) await collectUrls(e.loc, out, depth + 1);
      if (out.size > 8000) break;
    }
    return;
  }

  if (doc.urlset?.url) {
    const entries = [].concat(doc.urlset.url);
    for (const e of entries) if (e.loc) out.add(e.loc);
  }
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

function tokenize(term) {
  return (term || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2);
}

/** Score a pre-decoded, lowercased slug against a set of tokens by overlap. */
function scoreSlug(slug, tokens) {
  let score = 0;
  for (const t of tokens) if (slug.includes(t)) score += 1;
  return score;
}

/**
 * Anchor-first, multi-term candidate discovery.
 * `termGroups` is an array of search phrases (entities, topics, synonyms). For
 * each group we keep the top `perTerm` URLs that genuinely match (score > 0),
 * then union across groups. This surfaces topically diverse pages instead of
 * only slug look-alikes of one keyword. No score-0 padding — quality over count.
 *
 * @returns {{origin, total, candidates:string[], byTerm:Object}}
 */
export async function discoverCandidates(
  domain,
  termGroups,
  { perTerm = 6, cap = 40, exclude = [], cache } = {}
) {
  const { origin, urls: allUrls } = await getAllSitemapUrls(domain, { cache: cache?.sitemap });
  if (allUrls.length === 0) return { origin, total: 0, candidates: [], byTerm: {} };

  // Never recommend the article's own page (or other excluded URLs). Compare
  // by host+path so a submitted URL still matches its sitemap-canonical form
  // even when they differ in scheme, "www.", trailing slash, or query/fragment.
  const norm = (u) => {
    try {
      const url = new URL((u || "").trim());
      return (url.hostname.replace(/^www\./, "") + url.pathname.replace(/\/+$/, "")).toLowerCase();
    } catch {
      return (u || "").trim().toLowerCase().replace(/\/+$/, "");
    }
  };
  const excludeSet = new Set(exclude.map(norm));
  const urls = allUrls.filter((u) => !excludeSet.has(norm(u)));

  // Decode + lowercase each URL once up front instead of inside the per-term
  // loop below, where the same URL would otherwise be re-decoded for every
  // search term (dozens of times per run against a large sitemap).
  const slugOf = new Map(urls.map((u) => [u, decodeURIComponent(u).toLowerCase()]));

  // Track, per URL, its best single-term score and how many distinct terms hit
  // it. Ranking by these pushes genuinely-relevant pages to the top and lets us
  // trim the long tail of weak, noisy matches before the model ever sees them.
  const best = new Map(); // url -> { score, hits }
  const byTerm = {};

  for (const term of termGroups) {
    const tokens = tokenize(term);
    if (tokens.length === 0) continue;
    const matches = urls
      .map((u) => ({ url: u, score: scoreSlug(slugOf.get(u), tokens) }))
      .filter((m) => m.score > 0)
      .sort((a, b) => b.score - a.score || a.url.length - b.url.length)
      .slice(0, perTerm);
    if (matches.length) byTerm[term] = matches.map((m) => m.url);
    for (const m of matches) {
      const prev = best.get(m.url) || { score: 0, hits: 0 };
      best.set(m.url, { score: Math.max(prev.score, m.score), hits: prev.hits + 1 });
    }
  }

  const candidates = [...best.entries()]
    .sort((a, b) => b[1].hits - a[1].hits || b[1].score - a[1].score || a[0].length - b[0].length)
    .slice(0, cap)
    .map(([url]) => url);

  return { origin, total: allUrls.length, candidates, byTerm };
}
