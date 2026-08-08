import { test } from "node:test";
import assert from "node:assert/strict";
import { isBlockedIp, assertSafeUrl, safeFetch } from "../lib/safeFetch.js";

test("isBlockedIp blocks loopback, private, link-local, metadata, and reserved IPv4", () => {
  const blocked = [
    "127.0.0.1",
    "10.0.0.1",
    "10.255.255.255",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254", // cloud metadata
    "0.0.0.0",
    "100.64.0.1", // CGNAT
    "198.18.0.1", // benchmarking
    "224.0.0.1", // multicast
    "240.0.0.1", // reserved
    "255.255.255.255",
  ];
  for (const ip of blocked) assert.equal(isBlockedIp(ip), true, `${ip} should be blocked`);
});

test("isBlockedIp allows ordinary public IPv4 addresses", () => {
  const allowed = ["8.8.8.8", "1.1.1.1", "93.184.216.34"];
  for (const ip of allowed) assert.equal(isBlockedIp(ip), false, `${ip} should be allowed`);
});

test("isBlockedIp blocks loopback, unique-local, link-local, and mapped IPv6", () => {
  const blocked = ["::1", "::", "fc00::1", "fd12:3456::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:169.254.169.254"];
  for (const ip of blocked) assert.equal(isBlockedIp(ip), true, `${ip} should be blocked`);
});

test("isBlockedIp allows ordinary public IPv6 addresses", () => {
  assert.equal(isBlockedIp("2606:4700:4700::1111"), false);
});

test("assertSafeUrl rejects non-http(s) protocols", async () => {
  await assert.rejects(() => assertSafeUrl("file:///etc/passwd"), /Unsupported protocol/);
  await assert.rejects(() => assertSafeUrl("ftp://example.com/x"), /Unsupported protocol/);
  await assert.rejects(() => assertSafeUrl("gopher://example.com/x"), /Unsupported protocol/);
});

test("assertSafeUrl rejects malformed URLs", async () => {
  await assert.rejects(() => assertSafeUrl("not a url"), /Invalid URL/);
});

test("assertSafeUrl rejects IP-literal loopback, private, and metadata targets", async () => {
  await assert.rejects(() => assertSafeUrl("http://127.0.0.1/"), /Blocked IP/);
  await assert.rejects(() => assertSafeUrl("http://192.168.1.1/admin"), /Blocked IP/);
  await assert.rejects(() => assertSafeUrl("http://169.254.169.254/latest/meta-data/"), /Blocked IP/);
  await assert.rejects(() => assertSafeUrl("http://[::1]/"), /Blocked IP/);
});

test("assertSafeUrl rejects blocked hostnames", async () => {
  await assert.rejects(() => assertSafeUrl("http://localhost:3000/"), /Blocked hostname/);
  await assert.rejects(() => assertSafeUrl("http://metadata.google.internal/"), /Blocked hostname/);
});

test("safeFetch rejects a private target before making any network request", async () => {
  await assert.rejects(() => safeFetch("http://127.0.0.1:9/"), /Blocked IP/);
});
