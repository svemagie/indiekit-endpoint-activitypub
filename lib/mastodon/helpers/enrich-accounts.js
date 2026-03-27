/**
 * Enrich embedded account objects in serialized statuses with real
 * follower/following/post counts from remote AP collections.
 *
 * Applies cached stats immediately. Uncached accounts are resolved
 * in the background (fire-and-forget) and will be populated for
 * subsequent requests.
 */
import { getCachedAccountStats } from "./account-cache.js";
import { resolveRemoteAccount } from "./resolve-account.js";

/**
 * Enrich account objects in a list of serialized statuses.
 * Applies cached stats synchronously. Uncached accounts are resolved
 * in the background for future requests.
 *
 * @param {Array} statuses - Serialized Mastodon Status objects (mutated in place)
 * @param {object} pluginOptions - Plugin options with federation context
 * @param {string} baseUrl - Server base URL
 */
export async function enrichAccountStats(statuses, pluginOptions, baseUrl) {
  if (!statuses?.length || !pluginOptions?.federation) return;

  const uncachedUrls = [];

  for (const status of statuses) {
    applyCachedOrCollect(status.account, uncachedUrls);
    if (status.reblog?.account) {
      applyCachedOrCollect(status.reblog.account, uncachedUrls);
    }
  }

  // Fire-and-forget background enrichment for uncached accounts.
  // Next request will pick up the cached results.
  if (uncachedUrls.length > 0) {
    resolveInBackground(uncachedUrls, pluginOptions, baseUrl);
  }
}

/**
 * Apply cached stats to an account, or collect its URL for background resolution.
 * @param {object} account - Account object to enrich
 * @param {string[]} uncachedUrls - Array to collect uncached URLs into
 */
function applyCachedOrCollect(account, uncachedUrls) {
  if (!account?.url) return;

  // Always check cache first — applies avatar + createdAt even for already-enriched accounts.
  // avatarUrl is stored in the cache by resolveRemoteAccount so it survives across requests
  // even when the timeline item's author.photo is empty (e.g. actor was on a Secure Mode
  // server when the item was originally received).

  const cached = getCachedAccountStats(account.url);
  if (cached) {
    account.followers_count = cached.followersCount || account.followers_count || 0;
    account.following_count = cached.followingCount || account.following_count || 0;
    account.statuses_count = cached.statusesCount || account.statuses_count || 0;
    if (cached.createdAt) account.created_at = cached.createdAt;
    if (cached.avatarUrl) {
      account.avatar = cached.avatarUrl;
      account.avatar_static = cached.avatarUrl;
    }
    return;
  }

  // Skip remote resolution if counts are already populated from some other source
  if (account.followers_count > 0 || account.statuses_count > 0) return;

  if (!uncachedUrls.includes(account.url)) {
    uncachedUrls.push(account.url);
  }
}

/**
 * Resolve accounts in background. Fire-and-forget — errors are silently ignored.
 * resolveRemoteAccount() populates the account cache as a side effect.
 * @param {string[]} urls - Actor URLs to resolve
 * @param {object} pluginOptions - Plugin options
 * @param {string} baseUrl - Server base URL
 */
function resolveInBackground(urls, pluginOptions, baseUrl) {
  const unique = [...new Set(urls)];
  const CONCURRENCY = 5;

  (async () => {
    for (let i = 0; i < unique.length; i += CONCURRENCY) {
      const batch = unique.slice(i, i + CONCURRENCY);
      await Promise.allSettled(
        batch.map((url) => resolveRemoteAccount(url, pluginOptions, baseUrl)),
      );
    }
  })().catch(() => {});
}
