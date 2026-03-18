/**
 * Centralized wrapper for ctx.lookupObject() with FEP-fe34 origin-based
 * security. All lookupObject calls MUST go through this helper so the
 * crossOrigin policy is applied consistently.
 *
 * @module lookup-helpers
 */

/**
 * Look up a remote ActivityPub object with cross-origin security.
 *
 * FEP-fe34 prevents spoofed attribution attacks by verifying that a
 * fetched object's `id` matches the origin of the URL used to fetch it.
 * Using `crossOrigin: "ignore"` tells Fedify to silently discard objects
 * whose id doesn't match the fetch origin, rather than throwing.
 *
 * @param {object} ctx - Fedify Context
 * @param {string|URL} input - URL or handle to look up
 * @param {object} [options] - Additional options passed to lookupObject
 * @returns {Promise<object|null>} Resolved object or null
 */
export function lookupWithSecurity(ctx, input, options = {}) {
  return ctx.lookupObject(input, {
    crossOrigin: "ignore",
    ...options,
  });
}
