/**
 * SSRF guard for federation dereferences.
 * @module ssrf-guard
 *
 * The Fedify federation is created with `allowPrivateAddress: true` because the
 * blog host (e.g. svemagie.net) resolves to an RFC-1918 LAN address, and the
 * server must dereference its OWN-SITE content during federation. That flag is
 * load-bearing and stays. The cost is that Fedify's blanket SSRF guard is off
 * for every fetch, so attacker-sourced URLs (quoteUrl, reply targets, boost
 * objects, resolved author URLs) could otherwise reach internal services.
 *
 * This guard re-establishes protection per-sink: it resolves the target host
 * via DNS and rejects any host whose resolved IP is private/reserved — UNLESS
 * the hostname STRING-EQUALS the trusted publication host. Allowlisting by
 * hostname (not by resolved IP) is deliberate: the publication's private IP is
 * shared by every other LAN service, so an IP allowlist would let any attacker
 * hostname resolving into that subnet through.
 *
 * KNOWN RESIDUAL RISK — DNS rebinding: this guard resolves DNS, then Fedify
 * performs its OWN resolution at connect time. A TTL=0 attacker can return a
 * public IP to this check and an internal IP to Fedify's fetch. Closing that
 * requires a connection-time check inside Fedify's document loader (tracked as
 * a follow-up). This guard DOES block literal-internal URLs, naive attacks, and
 * the previously-unguarded quote/reply/boost/author paths.
 */

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * Check whether an IP literal is in a private/reserved range.
 * @param {string} ip - IPv4 or IPv6 literal
 * @returns {boolean} True if private/reserved
 */
export function isPrivateIP(ip) {
  const family = isIP(ip);
  if (family === 0) return true; // not a valid IP → block defensively

  if (family === 4) {
    const [a, b] = ip.split(".").map(Number);
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local
    if (a === 127) return true; // 127.0.0.0/8 loopback
    if (a === 0) return true; // 0.0.0.0/8
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
    if (a >= 224) return true; // multicast + reserved
    return false;
  }

  // IPv6
  const lower = ip.toLowerCase();
  if (lower === "::1" || lower === "::") return true;
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateIP(mapped[1]); // IPv4-mapped
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // ULA fc00::/7
  if (lower.startsWith("fe8") || lower.startsWith("fe9") ||
      lower.startsWith("fea") || lower.startsWith("feb")) return true; // link-local fe80::/10
  return false;
}

/**
 * Assert that a URL is allowed to be dereferenced during federation.
 *
 * Resolves DNS and throws if the host's resolved IP is private/reserved,
 * unless the hostname string-equals `ownHost`. Non-HTTP(S) schemes are
 * rejected. DNS resolution failure fails closed (throws).
 *
 * @param {string|URL} input - URL to validate
 * @param {string} [ownHost] - Trusted publication hostname permitted to resolve
 *   to a private address (e.g. "svemagie.net"). When omitted, ALL private
 *   resolved IPs are blocked (fail-closed default).
 * @returns {Promise<void>} Resolves if allowed; rejects otherwise
 */
export async function assertLookupAllowed(input, ownHost) {
  let parsed;
  try {
    parsed = input instanceof URL ? input : new URL(input);
  } catch {
    throw new Error("SSRF guard: invalid URL");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`SSRF guard: blocked non-HTTP scheme ${parsed.protocol}`);
  }

  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");

  // Trusted publication host is allowed even when it resolves to a private IP.
  // String equality, NOT resolved-IP equality (shared-LAN-subnet bypass).
  if (ownHost && host === ownHost.toLowerCase()) return;

  // Host is already an IP literal — check directly, no DNS.
  if (isIP(host) !== 0) {
    if (isPrivateIP(host)) throw new Error(`SSRF guard: blocked private address ${host}`);
    return;
  }

  // Resolve ALL addresses; block if ANY is private (rebinding-resistant for the
  // resolve step — see module note re: connect-time residual).
  let addresses;
  try {
    addresses = await lookup(host, { all: true });
  } catch {
    throw new Error(`SSRF guard: DNS resolution failed for ${host}`);
  }
  if (addresses.length === 0) throw new Error(`SSRF guard: no addresses for ${host}`);

  for (const { address } of addresses) {
    if (isPrivateIP(address)) {
      throw new Error(`SSRF guard: ${host} resolves to private address ${address}`);
    }
  }
}
