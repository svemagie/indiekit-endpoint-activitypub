/**
 * Resolve a remote account via WebFinger + ActivityPub actor fetch.
 * Uses the Fedify federation instance to perform discovery.
 *
 * Shared by accounts.js (lookup) and search.js (resolve=true).
 */
import { serializeAccount } from "../entities/account.js";
import { cacheAccountStats } from "./account-cache.js";
import { remoteActorId } from "./id-mapping.js";
import { lookupWithSecurity } from "../../lookup-helpers.js";

/**
 * @param {string} acct - Account identifier (user@domain or URL)
 * @param {object} pluginOptions - Plugin options with federation, handle, publicationUrl
 * @param {string} baseUrl - Server base URL
 * @param {object|null} collections - MongoDB collections (optional; if provided, persists actorUrl to ap_actor_cache)
 * @returns {Promise<object|null>} Serialized Mastodon Account or null
 */
export async function resolveRemoteAccount(acct, pluginOptions, baseUrl, collections = null) {
  const { federation, handle, publicationUrl } = pluginOptions;
  if (!federation) return null;

  try {
    const ctx = federation.createContext(
      new URL(publicationUrl),
      { handle, publicationUrl },
    );

    // Determine lookup URI.
    // acct:user@domain — kept as a string; Fedify resolves it via WebFinger.
    // HTTP URLs — converted to URL objects for type-correct AP object fetch.
    let actorUri;
    if (acct.includes("@")) {
      const parts = acct.replace(/^@/, "").split("@");
      const username = parts[0];
      const domain = parts[1];
      if (!username || !domain) return null;
      actorUri = `acct:${username}@${domain}`;
    } else if (acct.startsWith("http")) {
      actorUri = new URL(acct);
    } else {
      return null;
    }

    // Use signed→unsigned fallback so servers rejecting signed GETs still resolve
    const documentLoader = await ctx.getDocumentLoader({ identifier: handle });
    const actor = await lookupWithSecurity(ctx, actorUri, { documentLoader });
    if (!actor) return null;

    // Extract data from the Fedify actor object
    const name = actor.name?.toString() || actor.preferredUsername?.toString() || "";
    const actorUrl = actor.id?.href || "";
    const username = actor.preferredUsername?.toString() || "";
    const domain = actorUrl ? new URL(actorUrl).hostname : "";
    const summary = actor.summary?.toString() || "";

    // Get avatar
    let avatarUrl = "";
    try {
      const icon = await actor.getIcon();
      avatarUrl = icon?.url?.href || "";
    } catch { /* ignore */ }

    // Get header image
    let headerUrl = "";
    try {
      const image = await actor.getImage();
      headerUrl = image?.url?.href || "";
    } catch { /* ignore */ }

    // Get collection counts (followers, following, outbox) — with 5 s timeout each
    const withTimeout = (promise, ms = 5000) => { // [patch] ap-resolve-account-timeout-safe
      const abort = new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), ms));
      promise.catch(() => {}); // suppress unhandled rejection if timeout settles first
      return Promise.race([promise, abort]);
    };

    // Fetch collection counts in parallel (max 5 s each) [patch] ap-resolve-account-timeout-safe
    const [followersResult, followingResult, outboxResult] = await Promise.allSettled([
      withTimeout(actor.getFollowers()),
      withTimeout(actor.getFollowing()),
      withTimeout(actor.getOutbox()),
    ]);
    const followersCount = followersResult.status === "fulfilled" && followersResult.value?.totalItems != null ? followersResult.value.totalItems : 0;
    const followingCount = followingResult.status === "fulfilled" && followingResult.value?.totalItems != null ? followingResult.value.totalItems : 0;
    const statusesCount = outboxResult.status === "fulfilled" && outboxResult.value?.totalItems != null ? outboxResult.value.totalItems : 0;

    // Get published/created date — normalize to UTC ISO so clients display it correctly.
    // Temporal.Instant.toString() preserves the original timezone offset;
    // passing through new Date() converts to "YYYY-MM-DDTHH:mm:ss.sssZ".
    let published = null;
    if (actor.published) {
      try {
        published = new Date(String(actor.published)).toISOString();
      } catch { /* ignore unparseable dates */ }
    }

    // Profile fields from attachments
    const fields = [];
    try {
      for await (const attachment of actor.getAttachments()) {
        if (attachment?.name) {
          fields.push({
            name: attachment.name?.toString() || "",
            value: attachment.value?.toString() || "",
          });
        }
      }
    } catch { /* ignore */ }

    const account = serializeAccount(
      {
        name,
        url: actorUrl,
        photo: avatarUrl,
        handle: `@${username}@${domain}`,
        summary,
        image: headerUrl,
        bot: actor.constructor?.name === "Service" || actor.constructor?.name === "Application",
        attachments: fields.length > 0 ? fields : undefined,
        createdAt: published || undefined,
      },
      { baseUrl },
    );

    // Override counts with real data from AP collections
    account.followers_count = followersCount;
    account.following_count = followingCount;
    account.statuses_count = statusesCount;

    // Cache stats (+ avatar URL) so embedded account objects in statuses can use them
    cacheAccountStats(actorUrl, {
      followersCount,
      followingCount,
      statusesCount,
      createdAt: published || undefined,
      avatarUrl: avatarUrl || undefined,
    });

    // Persist actor URL mapping to MongoDB so follow/unfollow survives server restarts
    // [patch] ap-actor-cache-await
    if (collections?.ap_actor_cache && actorUrl) {
      const hashId = remoteActorId(actorUrl);
      await collections.ap_actor_cache.updateOne(
        { _id: hashId },
        { $set: { actorUrl, updatedAt: new Date() } },
        { upsert: true },
      ).catch(() => {}); // non-fatal, but now awaited so entry exists before response
    }

    return account;
  } catch (error) {
    console.warn(`[Mastodon API] Remote account resolution failed for ${acct}:`, error.message);
    return null;
  }
}
