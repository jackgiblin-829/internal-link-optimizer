import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { getArticle } from "../lib/fetchArticle.js";
import { getAllSitemapUrls } from "../lib/sitemap.js";
import { fetchTitles } from "../lib/pageMeta.js";

// End-to-end proof that every outbound fetch path is actually WIRED to
// safeFetch — not just that safeFetch itself works (test/safeFetch.test.js
// already covers that in isolation).
//
// This exists because a merge once dropped the `import { safeFetch }` line
// from all three of these modules while leaving the safeFetch(...) call sites
// intact. A unit test of safeFetch alone cannot catch that class of bug.
//
// The trick: stand up a REAL loopback server that genuinely serves valid
// content, then assert each module refuses to use it anyway. If a fetch path
// ever regresses to bare fetch(), it will happily read this server and the
// corresponding test fails. The `control` test below proves the server is
// actually reachable, so none of these can pass vacuously.

let server;
let base;

const ARTICLE_HTML = `<!doctype html><html><head><title>Internal Secret Page</title></head>
<body><article><h1>Internal Secret Page</h1>
<p>${"This is internal content that must never be reachable through the tool. ".repeat(12)}</p>
</article></body></html>`;

before(async () => {
  server = http.createServer((req, res) => {
    const url = req.url.split("?")[0];
    if (url === "/robots.txt") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      return res.end(`Sitemap: ${base}/sitemap.xml\n`);
    }
    if (url === "/sitemap.xml") {
      res.writeHead(200, { "Content-Type": "application/xml" });
      return res.end(
        `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">` +
          `<url><loc>${base}/internal-page</loc></url></urlset>`
      );
    }
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(ARTICLE_HTML);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

test("control: the loopback server really is reachable and serving content", async () => {
  // If this fails, every assertion below would pass for the wrong reason.
  const res = await fetch(`${base}/article`);
  const body = await res.text();
  assert.equal(res.status, 200);
  assert.match(body, /Internal Secret Page/);

  const sitemap = await fetch(`${base}/sitemap.xml`);
  assert.match(await sitemap.text(), /internal-page/);
});

test("getArticle refuses a loopback URL even though it is serving a real article", async () => {
  await assert.rejects(
    () => getArticle(`${base}/article`),
    /Blocked IP|Blocked hostname/,
    "fetchArticle is no longer routed through safeFetch — SSRF protection is unwired"
  );
});

test("getAllSitemapUrls returns nothing for a loopback domain even though robots.txt + sitemap.xml are served", async () => {
  const { urls } = await getAllSitemapUrls(base);
  assert.deepEqual(
    urls,
    [],
    "sitemap discovery reached a loopback host — safeFetch is no longer wired into lib/sitemap.js"
  );
});

test("fetchTitles returns null for a loopback URL even though a <title> is served", async () => {
  const titles = await fetchTitles([`${base}/internal-page`]);
  assert.equal(
    titles.get(`${base}/internal-page`),
    null,
    "title fetching reached a loopback host — safeFetch is no longer wired into lib/pageMeta.js"
  );
});
