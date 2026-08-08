import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import TurndownService from "turndown";
import { UA } from "./http.js";

const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  bulletListMarker: "-",
});

export function looksLikeUrl(str) {
  const s = (str || "").trim();
  return /^https?:\/\/\S+$/i.test(s) && !/\s/.test(s.split("\n")[0]);
}

async function fetchHtml(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "text/html,*/*" },
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`Fetch failed (${res.status}) for ${url}`);
  return await res.text();
}

/**
 * Given article input (a URL or raw content), return:
 *  { title, markdown, existingUrls } where markdown is the clean article body.
 * If the input is raw text/markdown, it is returned as-is.
 */
export async function getArticle(input) {
  const trimmed = (input || "").trim();

  if (!looksLikeUrl(trimmed)) {
    return {
      title: "",
      markdown: trimmed,
      existingUrls: extractUrls(trimmed),
      sourceUrl: null,
    };
  }

  const html = await fetchHtml(trimmed);
  const dom = new JSDOM(html, { url: trimmed });
  const reader = new Readability(dom.window.document);
  const parsed = reader.parse();

  const contentHtml = parsed?.content || dom.window.document.body.innerHTML;
  let markdown = turndown.turndown(contentHtml).trim();

  // Heuristic: very little extracted text from a real page usually means the
  // content is client-rendered (JS) and wasn't in the initial HTML.
  const warning =
    markdown.length < 300
      ? "Very little content extracted — the page may be JavaScript-rendered. Consider pasting the article text instead."
      : null;

  return {
    title: parsed?.title || "",
    markdown,
    existingUrls: extractUrls(markdown),
    sourceUrl: trimmed,
    warning,
  };
}

/** Pull all markdown/inline links out of a string. */
export function extractUrls(md) {
  const urls = new Set();
  const mdLink = /\]\((https?:\/\/[^)\s]+)\)/g;
  const bare = /(https?:\/\/[^\s)<>"']+)/g;
  let m;
  while ((m = mdLink.exec(md))) urls.add(m[1]);
  while ((m = bare.exec(md))) urls.add(m[1]);
  return [...urls];
}
