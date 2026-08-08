# Internal Link Optimizer

Internal Link Optimizer is a local web app that finds relevant internal-link opportunities for an article, lets a human approve them, and inserts the selected links without rewriting the article.

Provide either a published article URL or raw article content, plus the site domain. The app reads the article, searches the site's XML sitemaps for related pages, uses an LLM to match natural anchor text to suitable destinations, and applies the approved links deterministically in code.

## Why it is useful

- Find internal-link opportunities without manually searching a large site.
- Recommend links from phrases that already exist in the article.
- Review every proposed anchor, destination, rationale, confidence level, and surrounding context.
- Prevent self-links, duplicate destinations, and links to pages already referenced by the article.
- Export updated Markdown or rendered HTML for a CMS.
- Process one article interactively or many article URLs in a batch.
- Suggest existing pages that could link back to the submitted article.

The guiding principle is recommendation quality over link quantity. The default workflow always keeps a human in control.

## How the logic works

The optimizer runs a seven-step pipeline.

### 1. Fetch and parse the article

If the input is a URL, the server downloads the page, extracts its primary readable content with Mozilla Readability, and converts the result to Markdown. If the input is raw text or Markdown, it uses that content directly.

The parser also records:

- The page title
- The submitted source URL
- URLs already linked from the article
- The article word count
- A warning when very little content is available in the initial HTML, which often indicates a JavaScript-rendered page

An article must contain at least 40 characters of extracted content to continue.

### 2. Summarize the article

The light LLM produces a specific three-to-five-sentence summary of the article's topics, subtopics, and key takeaways. This summary gives the later matching step broader context than a single target keyword can provide.

### 3. Extract linkable phrases

At the same time as summarization, the heavy LLM identifies up to 12 potential anchor phrases already present in the article. Each proposed anchor must be a verbatim substring, usually one to five words, and is paired with two to four related search terms. The model also identifies one primary keyword.

This is an anchor-first process: the tool begins with text a reader can actually click, then looks for a useful destination for that phrase. It does not invent anchor text or alter a sentence to make a link fit.

### 4. Discover and rank candidate pages

The app discovers XML sitemaps from `robots.txt`, `/sitemap.xml`, and `/sitemap_index.xml`. It follows sitemap indexes recursively to a maximum depth of three and collects up to roughly 8,000 URLs.

Candidate discovery uses the primary keyword, anchor phrases, and their related terms:

1. Each search phrase is tokenized into lowercase words longer than two characters.
2. Sitemap URLs receive one point for every token found in the decoded URL.
3. The top eight URL matches for each search phrase are combined into a wide candidate pool of up to 45 pages.
4. Pages matching more distinct search phrases rank ahead of pages with only one match. A stronger single-phrase overlap breaks ties, followed by shorter URLs.
5. The app fetches each candidate's HTML `<title>` with up to eight concurrent requests.
6. Candidates are re-ranked across all search tokens: a token in the page title adds two points, while a token in the URL adds one point.
7. Near-duplicate URLs, such as yearly versions of the same page, are collapsed to one representative.
8. The best 15 candidates continue to the matching step.

The submitted article URL and URLs already linked from the article are excluded before ranking. URL comparison normalizes the scheme, `www`, trailing slashes, query strings, and fragments so common canonical variants are treated as the same page.

Candidate discovery is intentionally sitemap-native and does not require a paid crawling service. It works best when page URLs or titles contain meaningful topic language.

### 5. Match anchors to destinations

The heavy LLM receives the article summary, approved verbatim anchor options, and each candidate's exact URL and page title. It proposes an anchor-to-URL match only when the destination has a clear and useful topical relationship.

The server then validates the model output and enforces these rules:

- The anchor must be one of the extracted phrases.
- The destination must be one of the discovered candidate URLs.
- Each anchor can be used only once.
- Each destination URL can be used only once.
- The total cannot exceed the link-density target.
- Confidence is normalized to `high`, `medium`, or `low`.

The automatic density target is approximately one link per 120 words, rounded and clamped between two and eight links. A value entered in **Max links** overrides that target.

### 6. Insert and verify links

The LLM never returns a rewritten article. It returns only structured edit instructions containing an existing anchor and an allowed URL. `lib/insertLinks.js` performs the actual insertion.

Before applying edits, the inserter masks fenced code blocks, inline code, and existing Markdown links. It then:

1. Tries longer anchors first so a short phrase cannot take the place of a more specific phrase that contains it.
2. Searches every occurrence for an exact-case, whole-word match.
3. Falls back to a case-insensitive whole-word match while preserving the article's original casing.
4. Wraps the first eligible occurrence as `[existing text](destination URL)`.
5. Locks the inserted link so a later edit cannot modify or nest inside it.
6. Skips missing anchors, duplicate anchors, and duplicate URLs instead of forcing an edit.

Finally, `verifyNoDrift` strips link syntax from the original and updated versions, normalizes whitespace, and confirms the underlying prose is identical. The UI reports the result. If verification fails, the content should not be published.

### 7. Suggest reverse links

In a separate LLM call, the optimizer selects up to five discovered pages that could benefit from linking back to the submitted article. Each suggestion includes a rationale and an anchor concept to look for on that page.

Reverse links are recommendations only. The app does not fetch or edit those source pages.

## Human review and output

The initial result displays all valid proposed links. Each proposal includes a checkbox, anchor in context, destination title and URL, confidence, and rationale.

Uncheck weak recommendations, adjust a destination when needed, and select **Apply**. The app re-applies only the selected edits to the original Markdown through the deterministic insertion code. This review action does not make another LLM call.

Available outputs include:

- Copy or download updated Markdown
- Copy rendered HTML for a CMS
- Preview the rendered article
- Export batch results as CSV

## Batch mode and history

Batch mode accepts multiple article URLs, processes them sequentially, and streams each result into the interface. Every successful item applies all validated recommendations automatically, so batch output should still be reviewed before publication.

Within one batch, the sitemap crawl and fetched page titles are cached and reused across articles from the same domain. Failed fetches are not retained in the cache, allowing later items to retry them.

Each successful run is saved locally under `data/runs/` and is available from the **History** tab. Full rendered HTML is regenerated when a saved run is opened to keep stored records smaller.

## Requirements

- Node.js 18 or newer; Node.js 20 is recommended
- An OpenAI or Anthropic API key
- A target site with accessible XML sitemaps
- Network access from the machine running the app to the article and candidate pages

## Installation

```bash
git clone https://github.com/jackgiblin-829/internal-link-optimizer.git
cd internal-link-optimizer
npm install
cp .env.example .env
```

Add one provider key to `.env`:

```dotenv
OPENAI_API_KEY=your-key
# or
ANTHROPIC_API_KEY=your-key
```

Start the application:

```bash
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
