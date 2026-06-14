import assert from "node:assert/strict";
import { test } from "node:test";

import { assertLookupAllowed, isPrivateIP } from "../lib/ssrf-guard.js";

test("isPrivateIP blocks internal IPv4", () => {
  for (const ip of ["10.100.0.5", "127.0.0.1", "169.254.169.254",
    "172.16.0.1", "172.31.255.255", "192.168.1.1", "0.0.0.0", "100.64.0.1"]) {
    assert.equal(isPrivateIP(ip), true, `${ip} should be private`);
  }
});

test("isPrivateIP allows public IPv4", () => {
  for (const ip of ["8.8.8.8", "1.1.1.1", "172.15.0.1", "172.32.0.1"]) {
    assert.equal(isPrivateIP(ip), false, `${ip} should be public`);
  }
});

test("isPrivateIP blocks internal IPv6 + IPv4-mapped", () => {
  for (const ip of ["::1", "fc00::1", "fd12::1", "fe80::1", "::ffff:10.0.0.1"]) {
    assert.equal(isPrivateIP(ip), true, `${ip} should be private`);
  }
});

test("assertLookupAllowed blocks attacker host resolving to internal IP literal", async () => {
  await assert.rejects(() => assertLookupAllowed("http://10.100.0.5/inbox"), /private address/);
  await assert.rejects(() => assertLookupAllowed("http://127.0.0.1/"), /private address/);
  await assert.rejects(() => assertLookupAllowed("http://[::1]/"), /private address/);
  await assert.rejects(() => assertLookupAllowed("http://169.254.169.254/latest/"), /private address/);
});

test("assertLookupAllowed blocks non-HTTP schemes", async () => {
  await assert.rejects(() => assertLookupAllowed("file:///etc/passwd"), /non-HTTP/);
});

test("assertLookupAllowed PERMITS own-host even when it resolves to a private IP", async () => {
  // localhost resolves to 127.0.0.1 (private). With ownHost=localhost the guard
  // must allow it — this is the own-site-federation exception that keeps
  // svemagie.net (on the LAN) reachable.
  await assert.doesNotReject(() => assertLookupAllowed("http://localhost/users/sven", "localhost"));
});

test("assertLookupAllowed BLOCKS a different host even with ownHost set (no IP-allowlist leak)", async () => {
  // ownHost is set to localhost, but the target is a DIFFERENT internal literal.
  // Must still block — proves allowlist is by hostname, not by resolved IP.
  await assert.rejects(() => assertLookupAllowed("http://10.100.0.5/", "localhost"), /private address/);
});

test("assertLookupAllowed permits a public host", async () => {
  await assert.doesNotReject(() => assertLookupAllowed("https://example.com/users/alice"));
});
