import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// These tests exercise the real HTTP API by spawning the actual server
// process (rather than importing server.js, which calls app.listen() at
// module load time with no way to opt out). This is a black-box test of
// exactly what ships, on an isolated port with no API key configured so it
// can never make a real LLM call.

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = join(__dirname, "..", "server.js");
const PROJECT_ROOT = join(__dirname, "..");
const PORT = 5199;
const BASE = `http://127.0.0.1:${PORT}`;

let child;
let stderr = "";

async function waitForServer(timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Server did not become ready in time. Stderr:\n${stderr}`);
}

before(async () => {
  child = spawn(process.execPath, [SERVER_PATH], {
    cwd: PROJECT_ROOT,
    env: { ...process.env, PORT: String(PORT), LLM_PROVIDER: "anthropic", OPENAI_API_KEY: "", ANTHROPIC_API_KEY: "" },
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  await waitForServer();
});

after(() => {
  child?.kill();
});

test("GET /api/health reports provider, models, and no key configured", async () => {
  const res = await fetch(`${BASE}/api/health`);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.provider, "anthropic");
  assert.equal(body.hasKey, false);
  assert.ok(body.models.light && body.models.heavy);
});

test("POST /api/apply rejects a missing originalArticle", async () => {
  const res = await fetch(`${BASE}/api/apply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ edits: [] }),
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.error, /originalArticle/);
});

test("POST /api/apply rejects edits that isn't an array", async () => {
  const res = await fetch(`${BASE}/api/apply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ originalArticle: "Some text.", edits: "not an array" }),
  });
  assert.equal(res.status, 400);
});

test("POST /api/apply rejects an empty body entirely", async () => {
  const res = await fetch(`${BASE}/api/apply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 400);
});

test("POST /api/apply applies a valid edit and returns the expected shape", async () => {
  const res = await fetch(`${BASE}/api/apply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      originalArticle: "The quick brown fox jumps.",
      edits: [{ anchor: "brown fox", url: "https://example.com/fox" }],
    }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.updatedArticle, "The quick [brown fox](https://example.com/fox) jumps.");
  assert.equal(body.driftOk, true);
  assert.equal(body.added.length, 1);
  assert.equal(body.skipped.length, 0);
  assert.ok(body.updatedHtml.includes("brown fox"));
});

test("POST /api/apply silently drops malformed edit entries instead of erroring", async () => {
  const res = await fetch(`${BASE}/api/apply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      originalArticle: "The quick brown fox jumps.",
      edits: [null, { anchor: "brown fox" }, { url: "https://example.com/fox" }, "garbage", 42],
    }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.added.length, 0);
  assert.equal(body.skipped.length, 0);
});

test("POST /api/run fails clearly when no API key is configured, without attempting the pipeline", async () => {
  const res = await fetch(`${BASE}/api/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ article: "Some text", domain: "example.com" }),
  });
  const text = await res.text();
  assert.match(text, /"type":"error"/);
  assert.match(text, /ANTHROPIC_API_KEY/);
});

test("POST /api/batch fails clearly when no API key is configured", async () => {
  const res = await fetch(`${BASE}/api/batch`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ urls: "https://example.com/a", domain: "example.com" }),
  });
  const text = await res.text();
  assert.match(text, /"type":"error"/);
  assert.match(text, /ANTHROPIC_API_KEY/);
});

test("GET /api/history returns an array", async () => {
  const res = await fetch(`${BASE}/api/history`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(Array.isArray(body));
});

test("GET /api/history/:id returns 404 for an unknown id", async () => {
  const res = await fetch(`${BASE}/api/history/does-not-exist`);
  assert.equal(res.status, 404);
});
