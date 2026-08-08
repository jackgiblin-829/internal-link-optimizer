import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseSitemapXml,
  tokenize,
  scoreSlug,
  normalizeUrlForComparison,
} from "../lib/sitemap.js";

test("parseSitemapXml reads a standard urlset sitemap", () => {
  const xml = `<?xml version="1.0"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://example.com/a</loc></url>
  <url><loc>https://example.com/b</loc></url>
</urlset>`;
  const result = parseSitemapXml(xml);
  assert.deepEqual(result.pageUrls, ["https://example.com/a", "https://example.com/b"]);
  assert.deepEqual(result.sitemapUrls, []);
});

test("parseSitemapXml reads a sitemap index", () => {
  const xml = `<?xml version="1.0"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>https://example.com/sitemap-1.xml</loc></sitemap>
  <sitemap><loc>https://example.com/sitemap-2.xml</loc></sitemap>
</sitemapindex>`;
  const result = parseSitemapXml(xml);
  assert.deepEqual(result.sitemapUrls, ["https://example.com/sitemap-1.xml", "https://example.com/sitemap-2.xml"]);
  assert.deepEqual(result.pageUrls, []);
});

test("parseSitemapXml handles a single <url> entry without an array wrapper", () => {
  const xml = `<urlset><url><loc>https://example.com/only</loc></url></urlset>`;
  const result = parseSitemapXml(xml);
  assert.deepEqual(result.pageUrls, ["https://example.com/only"]);
});

test("parseSitemapXml fails closed on garbage input (no fabricated URLs, whatever the shape)", () => {
  // fast-xml-parser is lenient — it rarely throws, even on non-XML or
  // truncated input; it just yields nothing usable. Either way (null, or an
  // object with empty arrays), no URLs should ever surface.
  for (const garbage of ["this is not xml at all { } <<>>", "<urlset><url><loc>unterminated", ""]) {
    const result = parseSitemapXml(garbage);
    const pageUrls = result?.pageUrls ?? [];
    const sitemapUrls = result?.sitemapUrls ?? [];
    assert.equal(pageUrls.length + sitemapUrls.length, 0, `garbage input leaked a URL: ${garbage}`);
  }
});

test("parseSitemapXml returns empty arrays for a well-formed but empty sitemap", () => {
  const result = parseSitemapXml(`<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></urlset>`);
  assert.deepEqual(result.pageUrls, []);
  assert.deepEqual(result.sitemapUrls, []);
});

test("parseSitemapXml skips <url> entries with no <loc>", () => {
  const xml = `<urlset><url><lastmod>2024-01-01</lastmod></url><url><loc>https://example.com/x</loc></url></urlset>`;
  const result = parseSitemapXml(xml);
  assert.deepEqual(result.pageUrls, ["https://example.com/x"]);
});

test("tokenize lowercases, strips punctuation, and drops short tokens", () => {
  assert.deepEqual(tokenize("Hiking Boots & Gear!"), ["hiking", "boots", "gear"]);
});

test("tokenize returns an empty array for empty or whitespace-only input", () => {
  assert.deepEqual(tokenize(""), []);
  assert.deepEqual(tokenize("   "), []);
});

test("scoreSlug counts how many tokens appear in the slug", () => {
  assert.equal(scoreSlug("/blog/best-hiking-boots", ["hiking", "boots"]), 2);
  assert.equal(scoreSlug("/blog/best-hiking-boots", ["hiking", "tents"]), 1);
  assert.equal(scoreSlug("/blog/best-hiking-boots", ["tents"]), 0);
});

test("normalizeUrlForComparison treats scheme, www, trailing slash, query, and fragment as equivalent", () => {
  const variants = [
    "https://example.com/topic",
    "http://example.com/topic",
    "https://www.example.com/topic",
    "https://example.com/topic/",
    "https://example.com/topic?utm_source=x",
    "https://example.com/topic#section",
    "HTTPS://EXAMPLE.COM/TOPIC",
  ];
  const normalized = new Set(variants.map(normalizeUrlForComparison));
  assert.equal(normalized.size, 1);
});

test("normalizeUrlForComparison distinguishes different paths", () => {
  assert.notEqual(
    normalizeUrlForComparison("https://example.com/topic-a"),
    normalizeUrlForComparison("https://example.com/topic-b")
  );
});

test("normalizeUrlForComparison falls back gracefully on unparseable input", () => {
  assert.equal(normalizeUrlForComparison("not a url/"), "not a url");
});
