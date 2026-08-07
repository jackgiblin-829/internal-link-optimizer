import { marked } from "marked";
import { insertLinks, verifyNoDrift } from "./insertLinks.js";

marked.setOptions({ mangle: false, headerIds: false });

/** Render markdown to HTML with the same settings applyEdits uses. */
export function markdownToHtml(markdown) {
  return marked.parse(markdown);
}

/** First sentence/line containing the anchor, for review context. */
export function contextFor(markdown, anchor) {
  const idx = markdown.indexOf(anchor);
  if (idx === -1) return "";
  // Expand to sentence-ish boundaries around the anchor.
  let start = markdown.lastIndexOf("\n", idx);
  const dotBefore = markdown.lastIndexOf(". ", idx);
  start = Math.max(start, dotBefore === -1 ? 0 : dotBefore + 2, 0);
  let end = markdown.indexOf("\n", idx + anchor.length);
  const dotAfter = markdown.indexOf(". ", idx + anchor.length);
  const ends = [end, dotAfter === -1 ? -1 : dotAfter + 1, markdown.length].filter((n) => n > idx);
  end = Math.min(...ends);
  return markdown.slice(start, end).trim().replace(/\s+/g, " ").slice(0, 240);
}

/**
 * Apply a set of {anchor,url} edits to the original article markdown.
 * Pure + fast (no LLM). Returns the updated markdown, rendered HTML, the drift
 * check, and per-link added/skipped detail (with anchor context for review).
 *
 * `titles` (optional Map<url,title>) enriches the added-link report.
 */
export function applyEdits(originalMarkdown, edits, titles = new Map()) {
  const { markdown, applied, skipped } = insertLinks(originalMarkdown, edits);
  const drift = verifyNoDrift(originalMarkdown, markdown);

  const added = applied.map((a) => ({
    url: a.url,
    anchor: a.anchor,
    title: titles.get(a.url) || null,
    context: contextFor(originalMarkdown, a.anchor),
  }));

  return {
    updatedArticle: markdown,
    updatedHtml: marked.parse(markdown),
    driftOk: drift.ok,
    added,
    skipped: skipped.map((s) => ({ url: s.url, anchor: s.anchor, reason: s.reason })),
  };
}
