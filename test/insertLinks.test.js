import { test } from "node:test";
import assert from "node:assert/strict";
import { insertLinks, verifyNoDrift } from "../lib/insertLinks.js";

test("insertLinks wraps the anchor and leaves surrounding prose untouched", () => {
  const { markdown, applied, skipped } = insertLinks("The quick brown fox jumps.", [
    { anchor: "brown fox", url: "https://example.com/fox" },
  ]);
  assert.equal(markdown, "The quick [brown fox](https://example.com/fox) jumps.");
  assert.equal(applied.length, 1);
  assert.equal(skipped.length, 0);
});

test("insertLinks skips an anchor that isn't found verbatim", () => {
  const { markdown, applied, skipped } = insertLinks("The quick brown fox.", [
    { anchor: "red fox", url: "https://example.com/fox" },
  ]);
  assert.equal(markdown, "The quick brown fox.");
  assert.equal(applied.length, 0);
  assert.equal(skipped[0].reason, "anchor text not found verbatim in article");
});

test("insertLinks does not match an anchor embedded inside a longer word", () => {
  const { applied, skipped } = insertLinks("They toured the aerodrome at dawn.", [
    { anchor: "Rome", url: "https://example.com/rome" },
  ]);
  assert.equal(applied.length, 0);
  assert.equal(skipped[0].reason, "anchor text not found verbatim in article");
});

test("insertLinks links only the first eligible occurrence of a repeated anchor", () => {
  const { markdown, applied } = insertLinks("cats are great. cats are also independent.", [
    { anchor: "cats", url: "https://example.com/cats" },
  ]);
  assert.equal(applied.length, 1);
  assert.equal(markdown, "[cats](https://example.com/cats) are great. cats are also independent.");
});

test("insertLinks rejects reusing the same anchor or url for a second edit", () => {
  const { applied, skipped } = insertLinks("cats and cats and dogs.", [
    { anchor: "cats", url: "https://example.com/a" },
    { anchor: "cats", url: "https://example.com/b" },
    { anchor: "dogs", url: "https://example.com/a" },
  ]);
  assert.equal(applied.length, 1);
  assert.equal(skipped.length, 2);
  assert.equal(skipped[0].reason, "anchor already used for another link");
  assert.equal(skipped[1].reason, "url already used for another link");
});

test("insertLinks does not insert inside an existing markdown link", () => {
  const original = "See the [brown fox](https://other.example/fox) run.";
  const { markdown, applied } = insertLinks(original, [
    { anchor: "brown fox", url: "https://example.com/fox" },
  ]);
  assert.equal(markdown, original);
  assert.equal(applied.length, 0);
});

test("insertLinks does not insert inside inline code or fenced code blocks", () => {
  const original = "Run `brown fox` in a shell.\n\n```\nbrown fox\n```\n";
  const { markdown, applied } = insertLinks(original, [
    { anchor: "brown fox", url: "https://example.com/fox" },
  ]);
  assert.equal(markdown, original);
  assert.equal(applied.length, 0);
});

test("insertLinks falls back to case-insensitive match but preserves original casing", () => {
  const { markdown, applied } = insertLinks("The Brown Fox ran.", [
    { anchor: "brown fox", url: "https://example.com/fox" },
  ]);
  assert.equal(markdown, "The [Brown Fox](https://example.com/fox) ran.");
  assert.equal(applied[0].anchor, "Brown Fox");
});

test("insertLinks longer anchors claim their span before shorter substrings of them", () => {
  const { markdown } = insertLinks("New Delhi is the capital.", [
    { anchor: "Delhi", url: "https://example.com/delhi" },
    { anchor: "New Delhi", url: "https://example.com/new-delhi" },
  ]);
  assert.equal(markdown, "[New Delhi](https://example.com/new-delhi) is the capital.");
});

test("verifyNoDrift passes when only link syntax differs", () => {
  const original = "The quick brown fox jumps.";
  const updated = "The quick [brown fox](https://example.com/fox) jumps.";
  assert.equal(verifyNoDrift(original, updated).ok, true);
});

test("verifyNoDrift fails on a changed word", () => {
  const original = "The quick brown fox jumps.";
  const updated = "The slow brown fox jumps.";
  assert.equal(verifyNoDrift(original, updated).ok, false);
});

test("verifyNoDrift fails on whitespace-only drift, not just word changes", () => {
  const original = "The quick brown fox jumps.";
  const updated = "The  quick brown  fox jumps."; // double spaces inserted
  assert.equal(verifyNoDrift(original, updated).ok, false);
});

test("verifyNoDrift fails when a newline is added or removed", () => {
  const original = "Paragraph one.\nParagraph two.";
  const updated = "Paragraph one.\n\nParagraph two.";
  assert.equal(verifyNoDrift(original, updated).ok, false);
});

test("verifyNoDrift ignores link syntax on both sides, including pre-existing links", () => {
  const original = "See [docs](https://example.com/docs) for more.";
  const updated = "See [docs](https://example.com/docs) for [more](https://example.com/more).";
  assert.equal(verifyNoDrift(original, updated).ok, true);
});
