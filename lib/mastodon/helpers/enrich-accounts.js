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
 * @param {object|null} localProfile - ap_profile document for the local account (optional)
 */
export async function enrichAccountStats(statuses, pluginOptions, baseUrl, localProfile = null) {
  if (!statuses?.length || !pluginOptions?.federation) return;

  const publicationUrl = pluginOptions.publicationUrl || null;
  const uncachedUrls = [];

  for (const status of statuses) {
    applyCachedOrCollect(status.account, uncachedUrls, localProfile, publicationUrl);
    if (status.reblog?.account) {
      applyCachedOrCollect(status.reblog.account, uncachedUrls, localProfile, publicationUrl);
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
 * @param {object|null} localProfile - ap_profile document for short-circuiting local account
 * @param {string|null} publicationUrl - Local publication URL to match against
 */
function applyCachedOrCollect(account, uncachedUrls, localProfile = null, publicationUrl = null) {
  if (!account?.url) return;

  // Short-circuit for the local account: inject avatar/header from ap_profile directly.
  // resolveRemoteAccount for the local URL would loop back via NAT and always fail/timeout.
  if (localProfile && publicationUrl && account.url === publicationUrl) {
    if (!account.header && localProfile.image) {
      account.header = localProfile.image;
      account.header_static = localProfile.image;
    }
    if (!account.avatar && localProfile.icon) {
      account.avatar = localProfile.icon;
      account.avatar_static = localProfile.icon;
    }
    return;
  }

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
    if (cached.headerUrl) {
      account.header = cached.headerUrl;
      account.header_static = cached.headerUrl;
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
