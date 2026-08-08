import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

// Source guard: nothing in the server codebase may call the global fetch()
// directly — every outbound request has to go through lib/safeFetch.js, which
// blocks loopback/private/metadata targets and enforces timeouts and size caps.
//
// test/ssrfWiring.test.js proves the three fetch paths that exist TODAY are
// wired correctly. This catches the next one: a new module added later that
// reaches for bare fetch() would otherwise ship unguarded with every existing
// test still green.
//
// This is the one rule a linter would give us, without adding a linter and its
// dependency tree to an otherwise dependency-light project. If ESLint is ever
// introduced, no-restricted-globals supersedes this file.

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

// lib/safeFetch.js is the one place allowed to touch the global fetch — it is
// the wrapper everything else is required to go through.
const ALLOWED = new Set(["lib/safeFetch.js"]);

function collectJsFiles(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) collectJsFiles(full, out);
    else if (entry.endsWith(".js")) out.push(full);
  }
  return out;
}

// Strip comments so a mention of fetch() in prose isn't reported as a call.
// The [^:] guard keeps "https://" inside string literals from being treated
// as the start of a line comment.
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

// Case-sensitive on purpose: `safeFetch(` contains a capital F, so it can
// never match. Matches `fetch(`, `globalThis.fetch(`, `global.fetch(`.
const BARE_FETCH = /\bfetch\s*\(/;

test("no source file outside lib/safeFetch.js calls the global fetch()", () => {
  const files = [...collectJsFiles(join(ROOT, "lib")), join(ROOT, "server.js")];

  const offenders = [];
  for (const file of files) {
    const rel = relative(ROOT, file).split(sep).join("/");
    if (ALLOWED.has(rel)) continue;
    stripComments(readFileSync(file, "utf8"))
      .split("\n")
      .forEach((line, i) => {
        if (BARE_FETCH.test(line)) offenders.push(`${rel}:${i + 1} → ${line.trim()}`);
      });
  }

  assert.deepEqual(
    offenders,
    [],
    "Outbound requests must go through safeFetch() from lib/safeFetch.js, which blocks " +
      "loopback/private/metadata targets (SSRF). Offending call sites:\n  " +
      offenders.join("\n  ")
  );
});

test("the guard is scanning a realistic file set and the allowlisted file really uses fetch", () => {
  // Guards the guard: if collectJsFiles silently returned nothing, or the
  // allowlist pointed at a file that no longer calls fetch, the test above
  // would pass while checking nothing.
  const files = collectJsFiles(join(ROOT, "lib"));
  assert.ok(files.length >= 5, `expected to scan several lib files, found ${files.length}`);

  const safeFetchSrc = readFileSync(join(ROOT, "lib", "safeFetch.js"), "utf8");
  assert.match(stripComments(safeFetchSrc), BARE_FETCH);
});
