// Drift-proof link insertion.
//
// The LLM never emits the article prose. It only proposes edits — an exact
// anchor phrase (a verbatim substring of the article) and the URL to link it
// to. This module does the actual insertion in code, so the only possible
// change to the document is wrapping an existing substring in a markdown link.
// Anything the model proposes that isn't an exact match is skipped and reported.

const NUL = "\0"; // sentinel; effectively never present in article text

// A markdown link's URL span: any run of non-paren, non-space characters, or
// one level of balanced parens (covers real URLs like Wikipedia's
// `..._(disambiguation)`) without requiring a full recursive parser.
const LINK_RE = /\[[^\]]*\]\((?:[^()\s]|\([^()]*\))*\)/g;

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isWordChar(ch) {
  return !!ch && /[A-Za-z0-9_]/.test(ch);
}

// Find the first occurrence of `anchor` in `text` that isn't embedded inside
// a longer word (so anchor "Rome" can't match inside "aerodrome"). Tries
// exact case across every occurrence before falling back to case-insensitive.
function findAnchor(text, anchor) {
  for (const flags of ["g", "gi"]) {
    const re = new RegExp(escapeRe(anchor), flags);
    let m;
    while ((m = re.exec(text))) {
      const start = m.index;
      const end = start + m[0].length;
      const leftOk = !isWordChar(anchor[0]) || !isWordChar(text[start - 1]);
      const rightOk = !isWordChar(anchor[anchor.length - 1]) || !isWordChar(text[end]);
      if (leftOk && rightOk) return { index: start, text: m[0] };
    }
  }
  return null;
}

/**
 * Apply link edits to markdown.
 * @param {string} markdown  the original article
 * @param {Array<{url:string, anchor:string}>} edits
 * @returns {{ markdown:string, applied:Array, skipped:Array }}
 */
export function insertLinks(markdown, edits) {
  // Single store used both to protect existing regions and to lock newly
  // inserted links. A token is ` <index> `.
  const store = [];
  const stash = (s) => {
    const token = `${NUL}${store.length}${NUL}`;
    store.push(s);
    return token;
  };

  // Mask regions that must never receive a new link, in priority order:
  // fenced code, existing markdown links, inline code.
  let working = markdown
    .replace(/```[\s\S]*?```/g, stash)
    .replace(LINK_RE, stash)
    .replace(/`[^`]*`/g, stash);

  const applied = [];
  const skipped = [];
  const usedAnchors = new Set();
  const usedUrls = new Set();

  // Longer, more specific anchors claim their span first so a shorter anchor
  // that happens to be a substring of another (e.g. "Delhi" inside "New
  // Delhi") can't pre-empt it. Track original order to restore it below —
  // the review UI should list links in the order they were proposed.
  const ordered = (edits || [])
    .map((edit, i) => ({ edit, i }))
    .sort((a, b) => (b.edit.anchor || "").length - (a.edit.anchor || "").length);

  for (const { edit, i } of ordered) {
    const anchor = (edit.anchor || "").trim();
    const url = (edit.url || "").trim();

    if (!anchor || !url) {
      skipped.push({ url, anchor, reason: "missing anchor or url", i });
      continue;
    }
    if (usedAnchors.has(anchor.toLowerCase())) {
      skipped.push({ url, anchor, reason: "anchor already used for another link", i });
      continue;
    }
    if (usedUrls.has(url)) {
      skipped.push({ url, anchor, reason: "url already used for another link", i });
      continue;
    }

    const found = findAnchor(working, anchor);
    if (!found) {
      skipped.push({ url, anchor, reason: "anchor text not found verbatim in article", i });
      continue;
    }

    // Wrap this occurrence and immediately lock it so later edits can't insert
    // inside the anchor or URL we just created.
    const { index: idx, text: matched } = found;
    const token = stash(`[${matched}](${url})`);
    working = working.slice(0, idx) + token + working.slice(idx + matched.length);
    applied.push({ url, anchor: matched, i });
    usedAnchors.add(anchor.toLowerCase());
    usedUrls.add(url);
  }

  applied.sort((a, b) => a.i - b.i);
  skipped.sort((a, b) => a.i - b.i);
  for (const a of applied) delete a.i;
  for (const s of skipped) delete s.i;

  // Restore every token in a single pass (stored values contain no tokens).
  const result = working.replace(
    new RegExp(`${NUL}(\\d+)${NUL}`, "g"),
    (_, i) => store[Number(i)]
  );

  return { markdown: result, applied, skipped };
}

/** Remove markdown links, leaving just the anchor text: [text](url) -> text. */
function stripLinks(md) {
  return md.replace(/\[([^\]]*)\]\((?:[^()\s]|\([^()]*\))*\)/g, "$1");
}

/**
 * Level-2 safety net: confirm the only change between original and updated is
 * added/removed link syntax — i.e. the prose is byte-identical once links are
 * stripped from both. `ok` is decided on the byte-identical stripped bodies;
 * `original`/`updated` are whitespace-normalized copies for easy diffing on
 * failure, not part of the pass/fail check itself.
 */
export function verifyNoDrift(original, updated) {
  const stripped = (s) => stripLinks(s);
  const a = stripped(original);
  const b = stripped(updated);
  const norm = (s) => s.replace(/\s+/g, " ").trim();
  return { ok: a === b, original: norm(a), updated: norm(b) };
}
