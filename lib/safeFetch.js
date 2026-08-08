import dns from "node:dns/promises";
import net from "node:net";

const BLOCKED_HOSTNAMES = new Set(["localhost", "metadata.google.internal", "metadata"]);

// CIDR ranges that must never be reachable from user-supplied URLs: loopback,
// RFC1918 private space, link-local (includes the 169.254.169.254 cloud
// metadata endpoint), CGNAT, multicast, and reserved/broadcast space.
const IPV4_BLOCKED_RANGES = [
  "0.0.0.0/8",
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.0.0.0/24",
  "192.168.0.0/16",
  "198.18.0.0/15",
  "224.0.0.0/4",
  "240.0.0.0/4",
  "255.255.255.255/32",
];

function ipv4ToInt(ip) {
  return ip.split(".").reduce((acc, octet) => (acc << 8) + Number(octet), 0) >>> 0;
}

function ipv4InCidr(ip, cidr) {
  const [range, bitsStr] = cidr.split("/");
  const bits = Number(bitsStr);
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ipv4ToInt(ip) & mask) === (ipv4ToInt(range) & mask);
}

function isBlockedIpv4(ip) {
  return IPV4_BLOCKED_RANGES.some((cidr) => ipv4InCidr(ip, cidr));
}

function isBlockedIpv6(ip) {
  const lower = ip.toLowerCase();
  if (lower === "::1" || lower === "::") return true;
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // fc00::/7 unique local
  if (["fe8", "fe9", "fea", "feb"].some((p) => lower.startsWith(p))) return true; // fe80::/10 link-local
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isBlockedIpv4(mapped[1]);
  return false;
}

export function isBlockedIp(ip) {
  if (net.isIPv4(ip)) return isBlockedIpv4(ip);
  if (net.isIPv6(ip)) return isBlockedIpv6(ip);
  return true; // unrecognized format: fail closed
}

/**
 * Validate a URL is safe to fetch server-side: http(s) only, and neither the
 * hostname itself nor any address it resolves to may land in loopback,
 * private, link-local, or metadata space. Throws on any violation.
 */
export async function assertSafeUrl(urlString) {
  let url;
  try {
    url = new URL(urlString);
  } catch {
    throw new Error(`Invalid URL: ${urlString}`);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Unsupported protocol: ${url.protocol}`);
  }

  const hostname = url.hostname.toLowerCase();
  if (BLOCKED_HOSTNAMES.has(hostname)) {
    throw new Error(`Blocked hostname: ${hostname}`);
  }

  // WHATWG URL keeps IPv6 literals bracketed ("[::1]"); net.isIP and dns.lookup
  // both expect the bare address.
  const bareHostname = hostname.replace(/^\[(.*)\]$/, "$1");
  if (net.isIP(bareHostname)) {
    if (isBlockedIp(bareHostname)) throw new Error(`Blocked IP address: ${bareHostname}`);
    return url;
  }

  let addresses;
  try {
    addresses = await dns.lookup(hostname, { all: true });
  } catch {
    throw new Error(`Could not resolve hostname: ${hostname}`);
  }
  if (addresses.length === 0) throw new Error(`Could not resolve hostname: ${hostname}`);
  for (const { address } of addresses) {
    if (isBlockedIp(address)) {
      throw new Error(`Hostname ${hostname} resolves to a blocked address: ${address}`);
    }
  }

  return url;
}

const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_REDIRECTS = 5;

async function readBodyWithLimit(res, maxBytes) {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error(`Response exceeded ${maxBytes} byte limit`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf-8");
}

/**
 * SSRF-safe fetch: validates the URL (and every redirect hop) against
 * assertSafeUrl before making the request, and enforces a request timeout
 * and response-size cap. Returns { ok, status, url, headers, text }.
 */
export async function safeFetch(inputUrl, options = {}) {
  const {
    headers = {},
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxBytes = DEFAULT_MAX_BYTES,
    maxRedirects = DEFAULT_MAX_REDIRECTS,
  } = options;

  let currentUrl = inputUrl;
  for (let hop = 0; ; hop++) {
    const url = await assertSafeUrl(currentUrl);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res;
    try {
      res = await fetch(url, { headers, redirect: "manual", signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
    }

    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const location = res.headers.get("location");
      if (!location) throw new Error(`Redirect from ${url.href} had no Location header`);
      if (hop >= maxRedirects) throw new Error(`Too many redirects fetching ${inputUrl}`);
      currentUrl = new URL(location, url).href;
      continue;
    }

    const text = await readBodyWithLimit(res, maxBytes);
    return { ok: res.ok, status: res.status, url: url.href, headers: res.headers, text };
  }
}
