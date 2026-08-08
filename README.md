# Internal Link Optimizer

A local web app that adds relevant internal links to an article, based on the
"Internal Link Optimization Tool" agent template. You submit an article (a
published URL or raw content) plus your domain, and it:

1. **Fetches & parses** the article into clean markdown
2. **Summarizes** it (LLM)
3. **Finds linkable phrases** — pulls verbatim anchor phrases *out of the
   article* and, for each, a few search terms/topics (LLM). This anchor-first
   approach is what makes it work: it searches for pages the article can
   actually link to, instead of one narrow keyword that only finds slug
   look-alikes.
4. **Gets your sitemap** with a two-pass search: casts a wide net by term, fetches
   each candidate page's `<title>` (free content-awareness — no Firecrawl), then
   re-ranks by title relevance and keeps the best ~15. The article's own URL and
   pages it already links to are excluded (no self- or duplicate links).
5. **Matches** each anchor phrase to the single best candidate page (LLM), capped
   by a density target (~1 link / 120 words, or your override)
6. **Inserts** the matched links onto their verbatim anchor text — in code, so
   the article's wording cannot change
7. **Suggests reverse links** — existing pages that should link *back* to this
   article (display-only)

## Features

- **Human-in-the-loop approval** — every proposed link has a checkbox and shows
  its anchor in context. Uncheck the weak ones and hit *Apply*; re-insertion runs
  in code (no LLM call), so it's instant and still can't touch your prose.
- **Density control** — a *Max links* field (blank = auto by article length).
- **Markdown + HTML output** — copy/download markdown, or copy the rendered HTML
  for pasting into a CMS; a Preview tab renders it.
- **Batch mode** — paste many article URLs, process them all, export a CSV of
  links-added per article.
- **History** — every run is saved to `data/runs/` and browsable in the History
  tab.
- **JS-render warning** — if a page yields almost no text (client-rendered), it
  flags it so you can paste the content instead.

## Setup

Requires Node 18+ (Node 20 recommended).

```bash
cd ~/Claude/internal-link-optimizer
npm install
cp .env.example .env      # then edit .env and add ONE provider key
npm start
```

Open http://localhost:5055

## Provider (OpenAI or Anthropic)

Set **one** key in `.env`:

- `OPENAI_API_KEY=sk-...` → uses OpenAI (defaults: `gpt-4o-mini` / `gpt-4o`)
- `ANTHROPIC_API_KEY=sk-ant-...` → uses Anthropic (defaults: `claude-sonnet-5` / `claude-opus-5`)

It auto-detects from whichever key is present (OpenAI wins if both are set; force
with `LLM_PROVIDER=openai|anthropic`). Override models with `MODEL_LIGHT` /
`MODEL_HEAVY`. The provider and models in use are printed at startup and served
at `/api/health`.

> Note: defaults use standard chat models. If you point `MODEL_HEAVY` at an
> OpenAI reasoning model (o-series/GPT‑5), those reject a custom `temperature`
> and use `max_completion_tokens` — stick to `gpt-4o`/`gpt-4.1`-class models, or
> adjust `lib/llm.js`.

## Notes

- **Sitemap discovery** reads `robots.txt` plus `/sitemap.xml` and
  `/sitemap_index.xml`, following sitemap-index files. Candidates are ranked by
  how well the URL slug overlaps the primary keyword.
- **No Firecrawl needed.** The original template used Firecrawl's `map` endpoint;
  this build fetches the sitemap directly. If you later want Firecrawl's
  content-aware search, `lib/sitemap.js` is the single place to swap it in.
- **Models** default to `claude-sonnet-5` (summary/keyword) and
  `claude-opus-5` (link selection/insertion). Override in `.env`.
## How link insertion avoids LLM drift

The insertion step (6) is designed so the model **cannot** alter your prose:

1. **The model never emits the article.** It only returns a JSON list of edits —
   `{ anchor, url }` — where `anchor` must be a verbatim phrase from the article.
2. **Code performs the insertion** (`lib/insertLinks.js`). It finds that exact
   substring and wraps it in a markdown link. Existing links, inline code, and
   fenced code blocks are masked first, so nothing is ever inserted inside them.
   Anchors that aren't an exact match, or that repeat a URL, are skipped and
   reported — never forced.
3. **A verification pass** (`verifyNoDrift`) strips all links from the result and
   confirms it's byte-identical to the original prose. The UI shows a
   "prose unchanged ✓" badge; if it ever fails, it warns you not to publish.

Because the only operation code performs is wrapping an existing substring,
drift is structurally impossible rather than merely discouraged by the prompt.

## Known issues / planned improvements

Lower-priority items flagged in review but not yet addressed (no accuracy
impact, so deferred to a future commit):

- **Latency**: pipeline steps 5 (match links) and 7 (reverse suggestions) are
  independent LLM calls but run sequentially — could run in parallel like
  steps 2+3 already do (`lib/pipeline.js`).
- **Latency**: `/api/batch` processes articles fully sequentially; a bounded
  concurrency runner (like `fetchTitles`'s worker pool) would cut batch wall
  time (`server.js`).
- **Latency**: sitemap-index child sitemaps are fetched one at a time in
  `collectUrls` — could use the same bounded-concurrency pattern as
  `fetchTitles` (`lib/sitemap.js`).
- **Duplication**: `tokenize()` is defined separately (and identically) in
  `lib/pipeline.js` and `lib/sitemap.js`; the UA string is defined separately
  in `lib/sitemap.js`, `lib/fetchArticle.js`, and `lib/pageMeta.js`; the SSE
  `send` helper is redefined in both `/api/run` and `/api/batch` in
  `server.js`; `looksUrl` (`lib/pipeline.js`) duplicates the already-exported
  `looksLikeUrl` (`lib/fetchArticle.js`) with slightly different behavior.
  Worth consolidating into shared helpers so fixes don't need to land in
  multiple places.
- **Dead code**: `discoverCandidates`'s `byTerm` return value
  (`lib/sitemap.js`) is never read by any caller.
- **Minor**: `applyEdits` (`lib/apply.js`) calls `marked.parse(markdown)`
  directly instead of the `markdownToHtml()` helper it sits next to.
