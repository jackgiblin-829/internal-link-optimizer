import { complete, MODELS } from "./llm.js";
import { getArticle, looksLikeUrl } from "./fetchArticle.js";
import { discoverCandidates } from "./sitemap.js";
import { fetchTitles } from "./pageMeta.js";
import { applyEdits } from "./apply.js";
import { tokenize } from "./text.js";

/**
 * Run the internal-link-optimization pipeline.
 * `emit(event)` reports progress: { step, status, title, detail, data }.
 * Returns a result object including the PROPOSED links (for human approval),
 * the initial all-proposed application, and reverse-link suggestions.
 */
export async function runPipeline({ article, domain, maxLinks }, emit, { cache } = {}) {
  const step = (n, title) => ({
    start: (detail) => emit({ step: n, status: "running", title, detail }),
    done: (detail, data) => emit({ step: n, status: "done", title, detail, data }),
  });

  // 1. Fetch + parse the article.
  const s1 = step(1, "Fetch & parse article");
  s1.start(looksLikeUrl(article) ? `Fetching ${article}` : "Using provided content");
  const parsed = await getArticle(article);
  if (!parsed.markdown || parsed.markdown.length < 40) {
    throw new Error("Could not extract meaningful article content from the input.");
  }
  const wordCount = parsed.markdown.split(/\s+/).filter(Boolean).length;
  s1.done(
    `${wordCount.toLocaleString()} words${parsed.title ? ` · “${parsed.title}”` : ""}` +
      (parsed.warning ? ` · ⚠ ${parsed.warning}` : ""),
    { title: parsed.title, words: wordCount, warning: parsed.warning }
  );

  // 2 & 3 run concurrently: the anchor/phrase extraction (step 3) only reads
  // the article markdown, not the summary, so it doesn't need to wait on the
  // summarization call. Both are independent LLM round-trips — running them
  // in parallel halves the latency of this stretch of the pipeline.
  const s2 = step(2, "Summarize article");
  const s3 = step(3, "Find linkable phrases");
  s2.start("Asking the model for a specific 3–5 sentence summary");
  s3.start("Extracting verbatim anchor phrases and topics to search for");

  const [summary, extractionRaw] = await Promise.all([
    complete({
      model: MODELS.light,
      prompt:
        "Write a single plain paragraph (3–5 sentences) summarizing what this article covers, the " +
        "main topics addressed, and the key takeaways. Focus on specificity—mention the core subjects, " +
        "subtopics, and distinct concepts so this can be used to identify internal linking " +
        "opportunities.\n\nArticle content:\n" + parsed.markdown,
    }),
    complete({
      model: MODELS.heavy,
      temperature: 0,
      system:
        "You find internal-linking opportunities in an article. Output valid JSON only — no prose, " +
        "no code fences.",
      prompt:
        "From the article below, identify up to 12 phrases that would make strong internal-link " +
        "anchors — text a reader would benefit from clicking through to a related page on the site.\n\n" +
        "Strict rules:\n" +
        "- Each `anchor` MUST be copied VERBATIM from the article (an exact substring; same spelling, " +
        "casing, punctuation).\n" +
        "- Prefer specific, meaningful phrases: entities, places, cuisines, concepts, product/topic " +
        "names (~1–5 words). Avoid generic words like \"here\" or \"guide\".\n" +
        "- For each anchor, give 2–4 short `terms`: topics/entities/synonyms/broader categories to " +
        "search the site for a matching page. Terms need NOT appear in the article.\n" +
        "- Also give one `primaryKeyword` (1–5 words) the article should rank for.\n\n" +
        `Article title: ${parsed.title || "(none)"}\nBrand domain: ${domain}\n\n` +
        'Output JSON only:\n{"primaryKeyword":"...","anchors":[{"anchor":"verbatim phrase","terms":["..."]}]}\n\n' +
        `Article:\n${parsed.markdown}`,
    }),
  ]);
  s2.done(summary, { summary });

  const extraction = parseObject(extractionRaw);
  const anchorSpecs = Array.isArray(extraction.anchors) ? extraction.anchors : [];
  const keyword = extraction.primaryKeyword || "";
  if (anchorSpecs.length === 0) {
    throw new Error("Could not identify any linkable phrases in the article.");
  }
  s3.done(`${anchorSpecs.length} phrases · keyword “${keyword}”`, {
    keyword,
    anchors: anchorSpecs.map((a) => a.anchor),
  });

  // 4. Two-pass discovery: cast a WIDE slug net, fetch every candidate's title,
  //    then re-rank by title relevance (not just slug) and keep the best ~15.
  //    Excludes the article's own URL and pages it already links to.
  const s4 = step(4, "Get sitemap");
  s4.start(`Crawling ${domain} sitemap and searching for the article's topics`);
  const searchTerms = [
    ...new Set(
      [keyword, ...anchorSpecs.flatMap((a) => [a.anchor, ...(a.terms || [])])]
        .map((t) => (t || "").trim())
        .filter(Boolean)
    ),
  ];
  const exclude = [parsed.sourceUrl, ...(parsed.existingUrls || [])].filter(Boolean);
  const wide = await discoverCandidates(domain, searchTerms, { perTerm: 8, cap: 45, exclude, cache });
  if (wide.candidates.length === 0) {
    throw new Error(
      `No matching sitemap pages found for ${domain}. Check the domain, or the site's URLs may not ` +
        `contain topic keywords (slug-only matching can't reach them without Firecrawl).`
    );
  }
  const titles = await fetchTitles(wide.candidates, { concurrency: 8, cache: cache?.titles });

  // Re-rank the wide net by title + slug overlap with the search terms.
  const termTokens = [...new Set(searchTerms.flatMap(tokenize))];
  const relScore = (url) => {
    const title = (titles.get(url) || "").toLowerCase();
    const slug = safeDecode(url).toLowerCase();
    let s = 0;
    for (const t of termTokens) {
      if (title.includes(t)) s += 2;
      if (slug.includes(t)) s += 1;
    }
    return s;
  };
  // Collapse near-duplicate pages (same page across years/directions, e.g. an
  // itinerary repeated for 2026/2027/2028) so one representative takes one slot.
  const dupSig = (u) =>
    safeDecode(u)
      .toLowerCase()
      .replace(/https?:\/\/(www\.)?/, "")
      .replace(/\b\d{4}\b/g, "")
      .replace(/\.(html?|php)$/, "")
      .split(/[/?#]/)
      .filter(Boolean)
      .map((seg) => seg.split("-").filter(Boolean).join("-"))
      .join("/");
  const sorted = [...wide.candidates].sort(
    (a, b) => relScore(b) - relScore(a) || a.length - b.length
  );
  const seenSig = new Set();
  const candidates = [];
  for (const u of sorted) {
    const sig = dupSig(u);
    if (seenSig.has(sig)) continue;
    seenSig.add(sig);
    candidates.push(u);
    if (candidates.length >= 15) break;
  }
  const labeledCandidates = candidates.map((u) =>
    titles.get(u) ? `${u} — ${titles.get(u)}` : u
  );
  const withTitles = candidates.filter((u) => titles.get(u)).length;
  s4.done(
    `${candidates.length} candidates (from ${wide.candidates.length} matches · ${wide.total.toLocaleString()} URLs) · ${withTitles} titles`,
    { total: wide.total, origin: wide.origin, candidates }
  );

  // Density target: ~1 link per 120 words, clamped, unless the user overrode it.
  const autoMax = Math.max(2, Math.min(8, Math.round(wordCount / 120)));
  const targetMax = Number.isFinite(maxLinks) && maxLinks > 0 ? maxLinks : autoMax;

  // 5 & 7 run concurrently: reverse-link suggestions (step 7) only read
  // `summary`/`candidates`/`labeledCandidates`, not step 5's matched edits, so
  // — like steps 2+3 above — there's no reason to wait on step 5 to start
  // step 7's LLM call. Step 6 (insertion) still runs after both resolve,
  // since it needs step 5's `edits`. Step 7's call keeps its own try/catch so
  // a reverse-suggestion failure still degrades to `[]` without rejecting
  // step 5's result via Promise.all.
  const s5 = step(5, "Match links to pages");
  s5.start(`Matching anchors to pages (up to ${targetMax} links)`);
  const anchorPhrases = anchorSpecs.map((a) => a.anchor);

  const s7 = step(7, "Reverse link suggestions");
  s7.start("Finding existing pages that could link back to this article");

  const [matchRaw, reverseRaw] = await Promise.all([
    complete({
      model: MODELS.heavy,
      temperature: 0,
      system:
        "You match article anchor phrases to the single best internal URL. Output a valid JSON array " +
        "only — no prose, no code fences.",
      prompt:
        "Match anchor phrases to internal pages. Link an anchor to a candidate when they share a " +
        "clear, specific relationship — the same topic, ingredient, cuisine, region, entity, or a " +
        "closely related concept — such that a reader clicking that phrase would find the page " +
        "genuinely useful.\n\nRules:\n" +
        `- Aim to link EVERY anchor that has a clearly related destination (an ingredient → a recipe ` +
        `using it, a cuisine → a dish from it, a topic → a page about it). Propose up to ${targetMax} links.\n` +
        "- `anchor` MUST be exactly one of the provided anchor phrases (verbatim).\n" +
        "- `url` MUST be exactly one of the candidate URLs (copy exactly, without the title).\n" +
        "- Use each URL at most once and each anchor at most once.\n" +
        "- Don't link on vague or purely geographic guesses — but DO link when the destination clearly " +
        "shares the topic, ingredient, cuisine, or dish family.\n" +
        "- Spread links across different parts of the article; don't cluster several in one spot.\n" +
        "- Prefer natural, varied anchor text; avoid repetitive exact-match keyword anchors.\n" +
        "- Give a short `reason` (max ~12 words) and a `confidence` of high, medium, or low for each.\n\n" +
        "Each candidate is `URL — Page Title`; use the title to judge relevance.\n\n" +
        `Article summary: ${summary}\n\n` +
        `Anchor phrases:\n${anchorPhrases.join("\n")}\n\n` +
        `Candidates:\n${labeledCandidates.join("\n")}\n\n` +
        'Output JSON array only:\n' +
        '[{"anchor":"...","url":"...","reason":"why it fits","confidence":"high|medium|low"}]',
    }),
    complete({
      model: MODELS.heavy,
      temperature: 0,
      system: "You suggest reverse internal links. Output a valid JSON array only.",
      prompt:
        "Below is a NEW article and a list of existing pages on the same site (URL — Title). " +
        "Identify up to 5 existing pages that would most benefit from adding a link TO this new " +
        "article because they cover a closely related topic. For each, give a short `reason` and a " +
        "suggested `anchorConcept` (the kind of phrase on that page that could link here).\n\n" +
        `New article: ${parsed.title || keyword}\nSummary: ${summary}\nPrimary keyword: ${keyword}\n\n` +
        `Existing pages:\n${labeledCandidates.join("\n")}\n\n` +
        'Output JSON array only:\n[{"url":"...","reason":"...","anchorConcept":"..."}]',
    }).catch(() => null),
  ]);

  const rawEdits = parseEdits(matchRaw)
    .map((e) => ({ ...e, url: (e.url || "").trim().split(/\s/)[0] }))
    .filter((e) => anchorPhrases.includes(e.anchor) && candidates.includes(e.url));

  // Enforce one link per URL and per anchor, and the density cap.
  const seenUrl = new Set();
  const seenAnchor = new Set();
  const edits = [];
  for (const e of rawEdits) {
    if (edits.length >= targetMax) break;
    if (seenUrl.has(e.url) || seenAnchor.has(e.anchor)) continue;
    seenUrl.add(e.url);
    seenAnchor.add(e.anchor);
    const conf = String(e.confidence || "medium").toLowerCase();
    edits.push({
      anchor: e.anchor,
      url: e.url,
      reason: typeof e.reason === "string" ? e.reason : "",
      confidence: ["high", "medium", "low"].includes(conf) ? conf : "medium",
    });
  }
  s5.done(`${edits.length} matches proposed`, { matches: edits });

  // 6. Insert all proposed links in code (drift-proof) for the initial view.
  const s6 = step(6, "Insert & verify");
  s6.start("Inserting matched links on their verbatim anchor text");
  const application = applyEdits(parsed.markdown, edits, titles);
  s6.done(
    `${application.added.length} inserted · prose integrity ${application.driftOk ? "verified ✓" : "FAILED"}`,
    { driftOk: application.driftOk }
  );

  // Finish step 7: reverseRaw is null if its complete() call above threw.
  const reverse =
    reverseRaw == null
      ? []
      : parseEdits(reverseRaw)
          .filter((r) => candidates.includes(r.url))
          .slice(0, 5)
          .map((r) => ({ ...r, title: titles.get(r.url) || null }));
  s7.done(`${reverse.length} reverse suggestions`, { reverse });

  // Enrich proposed links with title + review context (from the application).
  const proposed = edits.map((e) => {
    // `url` alone is a reliable key: pipeline.js's own dedup loop above
    // guarantees each url appears at most once in `edits`/`application.added`.
    // (Matching on anchor text too used to break when insertLinks' case-
    // insensitive fallback matched different-cased text than the LLM anchor.)
    const a = application.added.find((x) => x.url === e.url);
    return {
      anchor: e.anchor,
      url: e.url,
      title: titles.get(e.url) || null,
      context: a?.context || "",
      reason: e.reason || "",
      confidence: e.confidence || "medium",
    };
  });

  // Every discovered page (with title) — offered as swap targets in the UI.
  const candidatePages = candidates.map((u) => ({ url: u, title: titles.get(u) || null }));

  return {
    summary,
    keyword,
    title: parsed.title,
    warning: parsed.warning || null,
    wordCount,
    targetMax,
    phrasesConsidered: anchorPhrases.length,
    candidatesConsidered: candidates.length,
    proposed,
    candidatePages,
    reverse,
    originalArticle: parsed.markdown,
    // Initial application (all proposed selected):
    added: application.added,
    skipped: application.skipped,
    driftOk: application.driftOk,
    updatedArticle: application.updatedArticle,
    updatedHtml: application.updatedHtml,
  };
}

// Slice out a balanced `open`...`close` span starting at the first `open`,
// tracking nesting depth and skipping over quoted-string contents so a
// bracket character inside a field value (e.g. a title like "Recipe [2024]")
// can't be mistaken for the JSON's real terminator.
function extractBalanced(text, open, close) {
  const start = text.indexOf(open);
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === open) depth++;
    else if (ch === close && --depth === 0) return text.slice(start, i + 1);
  }
  return null;
}

/** Extract a JSON array from model output, robustly. */
function parseEdits(raw) {
  if (!raw) return [];
  const stripped = raw.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const text = extractBalanced(stripped, "[", "]") ?? stripped;
  try {
    const arr = JSON.parse(text);
    return Array.isArray(arr) ? arr.filter((e) => e && typeof e === "object") : [];
  } catch {
    return [];
  }
}

/** Extract a JSON object from model output, robustly. */
function parseObject(raw) {
  if (!raw) return {};
  const stripped = raw.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const text = extractBalanced(stripped, "{", "}") ?? stripped;
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function safeDecode(u) {
  try {
    return decodeURIComponent(u);
  } catch {
    return u;
  }
}
