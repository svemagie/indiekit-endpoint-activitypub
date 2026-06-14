/**
 * Centralized wrapper for ctx.lookupObject() with FEP-fe34 origin-based
 * security. All lookupObject calls MUST go through this helper so the
 * crossOrigin policy is applied consistently.
 *
 * @module lookup-helpers
 */

import { assertLookupAllowed } from "./ssrf-guard.js";

/**
 * Look up a remote ActivityPub object with cross-origin security.
 *
 * FEP-fe34 prevents spoofed attribution attacks by verifying that a
 * fetched object's `id` matches the origin of the URL used to fetch it.
 * Using `crossOrigin: "ignore"` tells Fedify to silently discard objects
 * whose id doesn't match the fetch origin, rather than throwing.
 *
 * When an authenticated document loader is provided (for Authorized Fetch
 * compatibility), the lookup is tried with it first. If it fails (some
 * servers like tags.pub return 400 for signed GETs), a fallback to the
 * default unsigned loader is attempted automatically.
 *
 * @param {object} ctx - Fedify Context
 * @param {string|URL} input - URL or handle to look up
 * @param {object} [options] - Additional options passed to lookupObject.
 *   `options.ownHost` (string) is consumed by the SSRF guard and NOT forwarded
 *   to lookupObject: it names the trusted publication host permitted to resolve
 *   to a private LAN address (federation of own-site posts). Omit it for sinks
 *   that must never reach own-host — then ALL private resolved IPs are blocked.
 * @returns {Promise<object|null>} Resolved object or null
 */
export async function lookupWithSecurity(ctx, input, options = {}) {
  const { ownHost, ...lookupOptions } = options;

  // SSRF guard: federation runs with allowPrivateAddress:true (own host is on
  // the LAN), so guard attacker-controlled URLs here. Only http(s) URL inputs
  // are guarded; handle/acct: inputs resolve via WebFinger and aren't direct
  // fetches of an arbitrary host. Block → return null (existing contract).
  const isUrlInput = input instanceof URL ||
    (typeof input === "string" && /^https?:\/\//i.test(input));
  if (isUrlInput) {
    try {
      await assertLookupAllowed(input, ownHost);
    } catch (error) {
      const inputStr = typeof input === "string" ? input : input?.href || String(input);
      console.warn(`[ActivityPub] ${error.message} — refusing lookup of ${inputStr}`);
      return null;
    }
  }

  const baseOptions = { crossOrigin: "ignore", ...lookupOptions };

  let result = null;
  try {
    result = await ctx.lookupObject(input, baseOptions);
  } catch {
    // signed lookup threw — fall through to unsigned
  }

  // If signed lookup failed and we used a custom documentLoader,
  // retry without it (unsigned GET). Log the downgrade so operators can detect
  // key misconfigurations before they silently open unauth fetch paths.
  if (!result && options.documentLoader) {
    const inputStr = typeof input === "string" ? input : input?.href || String(input);
    console.debug(`[ActivityPub] Signed lookup failed for ${inputStr} — retrying unsigned`);
    try {
      const { documentLoader: _, ...unsignedOptions } = baseOptions;
      result = await ctx.lookupObject(input, unsignedOptions);
    } catch {
      // unsigned also failed — return null
    }
  }

  return result;
}
