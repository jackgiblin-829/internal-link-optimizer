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

Open [http://localhost:5055](http://localhost:5055).

For development with automatic server restarts:

```bash
npm run dev
```

## Configuration

| Variable | Purpose | Default |
| --- | --- | --- |
| `PORT` | Local server port | `5055` |
| `LLM_PROVIDER` | Force `openai` or `anthropic` | Auto-detected from the available key; OpenAI wins if both exist |
| `OPENAI_API_KEY` | OpenAI credential | None |
| `ANTHROPIC_API_KEY` | Anthropic credential | None |
| `MODEL_LIGHT` | Summary model | Provider-specific value in `lib/llm.js` |
| `MODEL_HEAVY` | Extraction and matching model | Provider-specific value in `lib/llm.js` |

The active provider and model names are printed at startup and returned by `GET /api/health`.

Model overrides must support the request parameters used by `lib/llm.js`, including `temperature` and the configured token limit. If a model uses a different API parameter contract, update that provider adapter before selecting it.

## API routes

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/api/health` | Report provider, models, key availability, and service status |
| `POST` | `/api/run` | Stream a single optimization run with server-sent events |
| `POST` | `/api/apply` | Deterministically apply a selected set of edits without an LLM call |
| `POST` | `/api/batch` | Stream sequential optimization results for multiple URLs |
| `GET` | `/api/history` | List locally saved runs |
| `GET` | `/api/history/:id` | Load one saved run and regenerate its HTML preview |

## Project structure

| Path | Responsibility |
| --- | --- |
| `server.js` | Express server, API routes, streaming, batch orchestration, and history integration |
| `lib/pipeline.js` | Seven-step optimization workflow, validation, ranking, and density controls |
| `lib/fetchArticle.js` | Article fetching, Readability extraction, Markdown conversion, and existing-link detection |
| `lib/sitemap.js` | Sitemap discovery, recursive URL collection, exclusions, and first-pass candidate scoring |
| `lib/pageMeta.js` | Bounded-concurrency page-title fetching and caching |
| `lib/llm.js` | OpenAI and Anthropic provider adapter and model configuration |
| `lib/insertLinks.js` | Deterministic anchor matching, protected-region masking, insertion, and drift verification |
| `lib/apply.js` | Edit application, HTML rendering, and review-context generation |
| `lib/store.js` | Local run persistence and history retrieval |
| `public/index.html` | Browser interface |

## Important limitations

- Candidate recall depends on accessible sitemaps and descriptive URL slugs or page titles. Relevant pages with opaque URLs may never enter the candidate pool.
- Standard HTTP fetching does not execute client-side JavaScript. Paste article content directly when Readability cannot extract it.
- Page-title requests can fail because of firewalls, bot protection, timeouts, or authentication. The URL remains available to the matcher, but with less context.
- LLM output is probabilistic. The server validates anchors and destinations, but a human should judge whether each recommendation is genuinely helpful.
- The first eligible occurrence of an anchor is linked. The model does not select a specific duplicate occurrence in the article.
- Run history is stored on the local machine and is not a shared database.
- Batch mode applies every validated proposal automatically and processes articles sequentially.

## Troubleshooting

**The app reports that an API key is missing**

Add the matching provider key to `.env`, then restart the server. Confirm the detected provider with `/api/health`.

**The article contains very little extracted content**

The page is probably rendered in the browser with JavaScript or protected from automated fetching. Paste the article's text or Markdown into the app instead of submitting its URL.

**No sitemap candidates are found**

Confirm that the domain is correct and that `robots.txt`, `/sitemap.xml`, or `/sitemap_index.xml` exposes the site's URLs. Sites with opaque slugs may need a future content-aware discovery integration.

**A proposed link was skipped**

The anchor may not have an eligible whole-word occurrence, may already be inside a link or code region, or may duplicate another selected anchor or destination. Skips are reported rather than forced.

**A page title is missing**

The destination may have timed out or rejected the title request. The matcher falls back to the exact URL.

## Development principles

The repository's product constraints are documented in `CLAUDE.md`. In particular:

- Recommendation quality takes priority over link quantity.
- Article prose must never be changed to create a link.
- Link insertion must remain deterministic.
- `verifyNoDrift` protections must not be removed.
- Human approval is the default workflow.
- New ranking behavior should be testable.
- Changes should be proposed through a branch and pull request, not committed directly to `main`.

## Planned improvements

- Run destination matching and reverse-link suggestions concurrently.
- Add bounded concurrency to batch processing and sitemap-index fetching.
- Consolidate duplicated tokenization, URL detection, user-agent, and event-stream helpers.
- Remove the unused per-term discovery return value.
- Add automated tests for candidate ranking, exclusion normalization, anchor boundaries, protected Markdown regions, duplicate handling, and drift verification.
