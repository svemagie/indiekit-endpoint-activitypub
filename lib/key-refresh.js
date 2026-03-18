/**
 * Proactive key refresh for remote actors.
 * Periodically re-fetches actor documents for active followers
 * whose keys may have rotated, keeping Fedify's KV cache fresh.
 * @module key-refresh
 */

import { lookupWithSecurity } from "./lookup-helpers.js";

/**
 * Update key freshness tracking after successfully processing
 * an activity from a remote actor.
 * @param {object} collections - MongoDB collections
 * @param {string} actorUrl - Remote actor URL
 */
export async function touchKeyFreshness(collections, actorUrl) {
  if (!actorUrl || !collections.ap_key_freshness) return;
  try {
    await collections.ap_key_freshness.updateOne(
      { actorUrl },
      {
        $set: { lastSeenAt: new Date().toISOString() },
        $setOnInsert: { lastRefreshedAt: new Date().toISOString() },
      },
      { upsert: true },
    );
  } catch {
    // Non-critical
  }
}

/**
 * Refresh stale keys for active followers.
 * Finds followers whose keys haven't been refreshed in 7+ days
 * and re-fetches their actor documents (up to 10 per cycle).
 *
 * @param {object} collections - MongoDB collections
 * @param {object} ctx - Fedify context (for lookupObject)
 * @param {string} handle - Our actor handle
 */
export async function refreshStaleKeys(collections, ctx, handle) {
  if (!collections.ap_key_freshness || !collections.ap_followers) return;

  const sevenDaysAgo = new Date(Date.now() - 7 * 86_400_000).toISOString();

  // Find actors with stale keys who are still our followers
  const staleActors = await collections.ap_key_freshness
    .aggregate([
      {
        $match: {
          lastRefreshedAt: { $lt: sevenDaysAgo },
        },
      },
      {
        $lookup: {
          from: "ap_followers",
          localField: "actorUrl",
          foreignField: "actorUrl",
          as: "follower",
        },
      },
      { $match: { "follower.0": { $exists: true } } },
      { $limit: 10 },
    ])
    .toArray();

  if (staleActors.length === 0) return;

  console.info(`[ActivityPub] Refreshing keys for ${staleActors.length} stale actors`);

  const documentLoader = await ctx.getDocumentLoader({ identifier: handle });

  for (const entry of staleActors) {
    try {
      const result = await lookupWithSecurity(ctx, new URL(entry.actorUrl), {
        documentLoader,
      });

      await collections.ap_key_freshness.updateOne(
        { actorUrl: entry.actorUrl },
        { $set: { lastRefreshedAt: new Date().toISOString() } },
      );

      if (!result) {
        // Actor gone — log as stale
        await collections.ap_activities?.insertOne({
          direction: "system",
          type: "StaleActor",
          actorUrl: entry.actorUrl,
          summary: `Actor ${entry.actorUrl} could not be resolved during key refresh`,
          receivedAt: new Date().toISOString(),
        });
      }
    } catch (error) {
      const status = error?.cause?.status || error?.message || "unknown";
      if (status === 410 || String(status).includes("410")) {
        // 410 Gone — actor deleted
        await collections.ap_activities?.insertOne({
          direction: "system",
          type: "StaleActor",
          actorUrl: entry.actorUrl,
          summary: `Actor ${entry.actorUrl} returned 410 Gone during key refresh`,
          receivedAt: new Date().toISOString(),
        });
      }
      // Update lastRefreshedAt even on failure to avoid retrying every cycle
      await collections.ap_key_freshness.updateOne(
        { actorUrl: entry.actorUrl },
        { $set: { lastRefreshedAt: new Date().toISOString() } },
      );
    }
  }
}

/**
 * Schedule key refresh job (runs on startup + every 24h).
 * @param {object} collections - MongoDB collections
 * @param {Function} getCtx - Function returning a Fedify context
 * @param {string} handle - Our actor handle
 */
export function scheduleKeyRefresh(collections, getCtx, handle) {
  const run = async () => {
    try {
      const ctx = getCtx();
      if (ctx) {
        await refreshStaleKeys(collections, ctx, handle);
      }
    } catch (error) {
      console.error("[ActivityPub] Key refresh failed:", error.message);
    }
  };

  // Run once on startup (delayed to let federation initialize)
  setTimeout(run, 30_000);

  // Then every 24 hours
  setInterval(run, 86_400_000);
}
