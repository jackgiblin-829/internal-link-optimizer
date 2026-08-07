// Free, content-aware candidate enrichment: fetch each candidate page's <title>
// so the matcher sees a human-readable label ("Hungarian Goulash Recipe")
// instead of an opaque slug. No paid API — just polite HTTP requests to the
// user's own site.

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0 Safari/537.36";

const ENTITIES = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&#039;": "'",
  "&apos;": "'",
  "&nbsp;": " ",
};

function decodeEntities(s) {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&[a-z#0-9]+;/gi, (m) => ENTITIES[m.toLowerCase()] ?? m);
}

async function fetchTitle(url, timeoutMs = 6000) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "text/html,*/*" },
      redirect: "follow",
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const html = await res.text();
    const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    if (!m) return null;
    return decodeEntities(m[1].replace(/\s+/g, " ").trim()).slice(0, 120);
  } catch {
    return null;
  }
}

/**
 * Fetch titles for a list of URLs with bounded concurrency.
 * Returns Map<url, title|null>. Failures map to null (caller falls back to URL).
 *
 * `cache` (optional Map<url, Promise<title|null>>) lets callers that process
 * many articles against overlapping candidate pages (e.g. batch runs) reuse
 * an already-fetched title instead of re-downloading the same page's HTML.
 */
export async function fetchTitles(urls, { concurrency = 6, cache } = {}) {
  const out = new Map();
  let i = 0;
  async function worker() {
    while (i < urls.length) {
      const url = urls[i++];
      let promise = cache?.get(url);
      if (!promise) {
        promise = fetchTitle(url);
        cache?.set(url, promise);
      }
      out.set(url, await promise);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, urls.length) }, worker)
  );
  return out;
}
