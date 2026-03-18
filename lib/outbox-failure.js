/**
 * Outbox permanent failure handling.
 * Cleans up dead followers when delivery permanently fails.
 *
 * - 410 Gone: Immediate full cleanup (actor is permanently gone)
 * - 404: Strike system — 3 failures over 7+ days triggers full cleanup
 *
 * @module outbox-failure
 */

import { logActivity } from "./activity-log.js";

const STRIKE_THRESHOLD = 3;
const STRIKE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * Clean up all data associated with an actor.
 * Removes follower record, their timeline items, and their notifications.
 *
 * @param {object} collections - MongoDB collections
 * @param {string} actorUrl - Actor URL to clean up
 * @param {string} reason - Reason for cleanup (for logging)
 */
async function cleanupActor(collections, actorUrl, reason) {
  const { ap_followers, ap_timeline, ap_notifications } = collections;

  // Remove from followers
  const deleted = await ap_followers.deleteOne({ actorUrl });

  // Remove their timeline items
  if (ap_timeline) {
    await ap_timeline.deleteMany({ "author.url": actorUrl });
  }

  // Remove their notifications
  if (ap_notifications) {
    await ap_notifications.deleteMany({ actorUrl });
  }

  if (deleted.deletedCount > 0) {
    console.info(`[outbox-failure] Cleaned up actor ${actorUrl}: ${reason}`);
  }
}

/**
 * Handle permanent outbox delivery failure.
 * Called by Fedify's setOutboxPermanentFailureHandler.
 *
 * @param {number} statusCode - HTTP status code (404, 410, etc.)
 * @param {readonly URL[]} actorIds - Array of actor ID URLs
 * @param {URL} inbox - The inbox URL that failed
 * @param {object} collections - MongoDB collections
 */
export async function onOutboxPermanentFailure(statusCode, actorIds, inbox, collections) {
  const inboxUrl = inbox?.href || String(inbox);

  for (const actorId of actorIds) {
    const actorUrl = actorId?.href || String(actorId);

    if (statusCode === 410) {
      // 410 Gone — immediate full cleanup
      await cleanupActor(collections, actorUrl, `410 Gone from ${inboxUrl}`);

      await logActivity(collections.ap_activities, {
        direction: "outbound",
        type: "DeliveryFailed:410",
        actorUrl,
        objectUrl: inboxUrl,
        summary: `Permanent delivery failure (410 Gone) to ${inboxUrl} — actor cleaned up`,
      }, {});
    } else {
      // 404 or other — strike system
      const now = new Date();
      const result = await collections.ap_followers.findOneAndUpdate(
        { actorUrl },
        {
          $inc: { deliveryFailures: 1 },
          $setOnInsert: { firstFailureAt: now.toISOString() },
          $set: { lastFailureAt: now.toISOString() },
        },
        { returnDocument: "after" },
      );

      if (!result) {
        // Not a follower — nothing to track or clean up
        continue;
      }

      const failures = result.deliveryFailures || 1;
      const firstFailure = result.firstFailureAt
        ? new Date(result.firstFailureAt)
        : now;
      const windowElapsed = now.getTime() - firstFailure.getTime() >= STRIKE_WINDOW_MS;

      if (failures >= STRIKE_THRESHOLD && windowElapsed) {
        // Confirmed dead — full cleanup
        await cleanupActor(
          collections,
          actorUrl,
          `${failures} failures over ${Math.round((now.getTime() - firstFailure.getTime()) / 86400000)}d (HTTP ${statusCode})`,
        );

        await logActivity(collections.ap_activities, {
          direction: "outbound",
          type: `DeliveryFailed:${statusCode}:cleanup`,
          actorUrl,
          objectUrl: inboxUrl,
          summary: `${failures} delivery failures over 7+ days — actor cleaned up`,
        }, {});
      } else {
        // Strike recorded, not yet confirmed dead
        await logActivity(collections.ap_activities, {
          direction: "outbound",
          type: `DeliveryFailed:${statusCode}:strike`,
          actorUrl,
          objectUrl: inboxUrl,
          summary: `Delivery strike ${failures}/${STRIKE_THRESHOLD} for ${actorUrl} (HTTP ${statusCode})`,
        }, {});
      }
    }
  }
}

/**
 * Reset delivery failure strikes for an actor.
 * Called when we receive an inbound activity from an actor,
 * proving they are alive despite previous delivery failures.
 *
 * @param {object} collections - MongoDB collections
 * @param {string} actorUrl - Actor URL
 */
export async function resetDeliveryStrikes(collections, actorUrl) {
  if (!actorUrl) return;
  // Only update if the fields exist — avoid unnecessary writes
  await collections.ap_followers.updateOne(
    { actorUrl, deliveryFailures: { $exists: true } },
    { $unset: { deliveryFailures: "", firstFailureAt: "", lastFailureAt: "" } },
  );
}
