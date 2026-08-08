import { marked } from "marked";
import sanitizeHtml from "sanitize-html";
import { insertLinks, verifyNoDrift } from "./insertLinks.js";

marked.setOptions({ mangle: false, headerIds: false });

// marked does not sanitize its output (https://marked.js.org/), and article
// markdown can carry raw HTML that survived Turndown's conversion from a
// user-supplied URL. Everything rendered for preview/export goes through this
// allowlist so script/event-handler/iframe-style payloads never reach the DOM.
const SANITIZE_OPTIONS = {
  allowedTags: [
    "p", "br", "hr", "strong", "em", "b", "i", "u", "s", "del", "sup", "sub",
    "a", "ul", "ol", "li", "blockquote", "code", "pre",
    "h1", "h2", "h3", "h4", "h5", "h6",
    "table", "thead", "tbody", "tr", "th", "td",
    "img",
  ],
  allowedAttributes: {
    a: ["href", "title", "target", "rel"],
    img: ["src", "alt", "title"],
  },
  allowedSchemes: ["http", "https", "mailto"],
  allowProtocolRelative: false,
  transformTags: {
    a: sanitizeHtml.simpleTransform("a", { rel: "noopener noreferrer" }),
  },
};

/** Render markdown to sanitized HTML with the same settings applyEdits uses. */
export function markdownToHtml(markdown) {
  return sanitizeHtml(marked.parse(markdown), SANITIZE_OPTIONS);
}

function stripLinksKeepText(md) {
  return md.replace(/\[([^\]]*)\]\((?:[^()\s]|\([^()]*\))*\)/g, "$1");
}

/**
 * Sentence-ish context around the span [start,end) — the actual position a
 * link was inserted at, not just wherever its anchor text first appears.
 * Any other link syntax inside the window is reduced to plain text too, so
 * the snippet reads as prose.
 */
function contextAround(markdown, start, end) {
  let from = markdown.lastIndexOf("\n", start);
  const dotBefore = markdown.lastIndexOf(". ", start);
  from = Math.max(from, dotBefore === -1 ? 0 : dotBefore + 2, 0);
  let to = markdown.indexOf("\n", end);
  const dotAfter = markdown.indexOf(". ", end);
  const ends = [to, dotAfter === -1 ? -1 : dotAfter + 1, markdown.length].filter((n) => n > start);
  to = Math.min(...ends);
  return stripLinksKeepText(markdown.slice(from, to)).trim().replace(/\s+/g, " ").slice(0, 240);
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

  // Anchors and URLs are each unique among `applied` (insertLinks enforces
  // this), so `[anchor](url)` pinpoints exactly the span just inserted —
  // context reflects where the link actually landed, not just the anchor's
  // first appearance anywhere in the article.
  const added = applied.map((a) => {
    const linkStr = `[${a.anchor}](${a.url})`;
    const start = markdown.indexOf(linkStr);
    return {
      url: a.url,
      anchor: a.anchor,
      title: titles.get(a.url) || null,
      context: start === -1 ? "" : contextAround(markdown, start, start + linkStr.length),
    };
  });

  return {
    updatedArticle: markdown,
    updatedHtml: markdownToHtml(markdown),
    driftOk: drift.ok,
    added,
    skipped: skipped.map((s) => ({ url: s.url, anchor: s.anchor, reason: s.reason })),
  };
}
