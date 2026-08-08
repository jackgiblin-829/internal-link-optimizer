import { test } from "node:test";
import assert from "node:assert/strict";
import { markdownToHtml } from "../lib/apply.js";

test("strips <script> tags", () => {
  const html = markdownToHtml("safe text <script>alert(1)</script> more text");
  assert.ok(!html.includes("<script"));
  assert.ok(!html.includes("alert(1)"));
});

test("strips event-handler attributes like onerror/onload", () => {
  const html = markdownToHtml('an image <img src=x onerror="alert(1)"> in prose');
  assert.ok(!/onerror/i.test(html));
});

test("strips javascript: URLs from links", () => {
  const html = markdownToHtml('a [link](javascript:alert(1)) here');
  assert.ok(!/javascript:/i.test(html));
});

test("strips data: URIs from image sources", () => {
  const html = markdownToHtml('<img src="data:image/svg+xml;base64,AAAA">');
  assert.ok(!/data:/i.test(html));
});

test("strips iframe, object, embed, and svg elements", () => {
  const html = markdownToHtml(
    '<iframe src="https://evil.example/"></iframe><object data="x"></object><embed src="x"><svg onload=alert(1)></svg>'
  );
  assert.ok(!/<iframe|<object|<embed|<svg/i.test(html));
});

test("adds rel=noopener noreferrer to anchors", () => {
  const html = markdownToHtml("[safe link](https://example.com)");
  assert.match(html, /rel="noopener noreferrer"/);
});

test("preserves ordinary prose, links, and images unchanged in meaning", () => {
  const html = markdownToHtml("Some **bold** prose with a [normal link](https://example.com/page) and a list:\n\n- one\n- two");
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /href="https:\/\/example\.com\/page"/);
  assert.match(html, /<li>one<\/li>/);
});
