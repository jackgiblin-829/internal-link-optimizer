import "dotenv/config";
import express from "express";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { runPipeline } from "./lib/pipeline.js";
import { applyEdits, markdownToHtml } from "./lib/apply.js";
import { hasKey, keyName, provider, MODELS } from "./lib/llm.js";
import { saveRun, listRuns, getRun } from "./lib/store.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 5055;

app.use(express.json({ limit: "4mb" }));
app.use(express.static(join(__dirname, "public")));

app.get("/api/health", (req, res) => {
  res.json({ ok: true, provider, models: MODELS, hasKey: hasKey() });
});

function sseHead(res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
}

/** SSE event sender bound to one response. */
function sseSend(res) {
  return (type, payload) => res.write(`data: ${JSON.stringify({ type, ...payload })}\n\n`);
}

// A monotonic-ish id without Date.now (kept out of pipeline); fine for the server.
let counter = 0;
function newId() {
  counter += 1;
  return `${Date.now()}_${counter}`;
}

// Streaming single run.
app.post("/api/run", async (req, res) => {
  const { article, domain, maxLinks } = req.body || {};
  sseHead(res);
  const send = sseSend(res);

  if (!hasKey()) {
    send("error", { message: `${keyName()} is not set. Add it to .env and restart.` });
    return res.end();
  }
  if (!article || !domain) {
    send("error", { message: "Both an article (URL or content) and a domain are required." });
    return res.end();
  }

  try {
    const result = await runPipeline(
      { article, domain, maxLinks: Number(maxLinks) || undefined },
      (evt) => send("step", evt)
    );
    const id = newId();
    // Persist a compact record (omit the full HTML to keep it small).
    saveRun(id, {
      id,
      date: new Date().toISOString(),
      input: { article, domain, maxLinks: Number(maxLinks) || null },
      result: { ...result, updatedHtml: undefined },
    }).catch(() => {});
    send("done", { result: { ...result, id } });
  } catch (err) {
    console.error(err);
    send("error", { message: err?.message || "Something went wrong." });
  }
  res.end();
});

// Re-apply a chosen SUBSET of links to the original article — pure code, no LLM.
// Powers the human-in-the-loop approval UI.
app.post("/api/apply", (req, res) => {
  const { originalArticle, edits } = req.body || {};
  if (typeof originalArticle !== "string" || !Array.isArray(edits)) {
    return res.status(400).json({ error: "originalArticle (string) and edits (array) are required." });
  }
  const clean = edits
    .filter((e) => e && typeof e.anchor === "string" && typeof e.url === "string")
    .map((e) => ({ anchor: e.anchor, url: e.url }));
  res.json(applyEdits(originalArticle, clean));
});

// Streaming batch run over many URLs (one line each). Approval is skipped in
// batch — all proposed links are applied — and each result is streamed as it
// completes so the UI can fill a table live.
app.post("/api/batch", async (req, res) => {
  const { urls, domain, maxLinks } = req.body || {};
  sseHead(res);
  const send = sseSend(res);

  if (!hasKey()) {
    send("error", { message: `${keyName()} is not set. Add it to .env and restart.` });
    return res.end();
  }
  const list = (Array.isArray(urls) ? urls : String(urls || "").split("\n"))
    .map((u) => u.trim())
    .filter(Boolean);
  if (list.length === 0 || !domain) {
    send("error", { message: "A list of article URLs and a domain are required." });
    return res.end();
  }

  send("start", { total: list.length });
  // Shared across every article in this batch: the domain's sitemap and any
  // candidate page's title only need to be fetched once, not once per article.
  const cache = { sitemap: new Map(), titles: new Map() };

  // Bounded-concurrency worker pool (same pattern as fetchTitles in
  // lib/pageMeta.js): each worker pulls the next index off a shared counter.
  // The UI keys every row by `index` (public/index.html), so out-of-order
  // completion renders correctly.
  let next = 0;
  async function worker() {
    while (next < list.length) {
      const i = next++;
      const article = list[i];
      send("item-start", { index: i, article });
      try {
        const result = await runPipeline(
          { article, domain, maxLinks: Number(maxLinks) || undefined },
          () => {}, // no per-step noise in batch
          { cache }
        );
        const id = newId();
        saveRun(id, {
          id,
          date: new Date().toISOString(),
          input: { article, domain, maxLinks: Number(maxLinks) || null },
          result: { ...result, updatedHtml: undefined },
        }).catch(() => {});
        send("item-done", {
          index: i,
          article,
          id,
          title: result.title,
          added: result.added,
          driftOk: result.driftOk,
          updatedArticle: result.updatedArticle,
        });
      } catch (err) {
        send("item-error", { index: i, article, message: err?.message || "failed" });
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(3, list.length) }, worker));
  send("batch-done", {});
  res.end();
});

app.get("/api/history", async (req, res) => {
  res.json(await listRuns());
});

app.get("/api/history/:id", async (req, res) => {
  const run = await getRun(req.params.id);
  if (!run) return res.status(404).json({ error: "not found" });
  // Saved runs omit updatedHtml to keep the file small; regenerate it here so
  // opening a historical run gets the same HTML preview a live run has.
  if (run.result?.updatedArticle && !run.result.updatedHtml) {
    run.result.updatedHtml = markdownToHtml(run.result.updatedArticle);
  }
  res.json(run);
});

app.listen(PORT, () => {
  console.log(`\n  Internal Link Optimizer → http://localhost:${PORT}`);
  console.log(`  Provider: ${provider}  ·  models: ${MODELS.light} / ${MODELS.heavy}\n`);
  if (!hasKey()) {
    console.log(`  ⚠  ${keyName()} not set — add it to .env before running.\n`);
  }
});
