/**
 * MongoDB-backed inbox processing queue.
 * Runs a setInterval-based processor that dequeues and processes
 * one activity at a time from ap_inbox_queue.
 * @module inbox-queue
 */

import { routeToHandler } from "./inbox-handlers.js";

/**
 * Process the next pending item from the inbox queue.
 * Uses findOneAndUpdate for atomic claim (prevents double-processing).
 *
 * @param {object} collections - MongoDB collections
 * @param {object} ctx - Fedify context
 * @param {string} handle - Our actor handle
 */
async function processNextItem(collections, ctx, handle) {
  const { ap_inbox_queue } = collections;
  if (!ap_inbox_queue) return;

  const item = await ap_inbox_queue.findOneAndUpdate(
    { status: "pending" },
    { $set: { status: "processing" } },
    { sort: { receivedAt: 1 }, returnDocument: "after" },
  );
  if (!item) return;

  try {
    await routeToHandler(item, collections, ctx, handle);
    await ap_inbox_queue.updateOne(
      { _id: item._id },
      { $set: { status: "completed", processedAt: new Date().toISOString() } },
    );
  } catch (error) {
    const attempts = (item.attempts || 0) + 1;
    await ap_inbox_queue.updateOne(
      { _id: item._id },
      {
        $set: {
          status: attempts >= (item.maxAttempts || 3) ? "failed" : "pending",
          attempts,
          error: error.message,
        },
      },
    );
    console.error(`[inbox-queue] Failed processing ${item.activityType} from ${item.actorUrl}: ${error.message}`);
  }
}

/**
 * Enqueue an activity for async processing.
 * @param {object} collections - MongoDB collections
 * @param {object} params
 * @param {string} params.activityType - Activity type name
 * @param {string} params.actorUrl - Actor URL
 * @param {string} [params.objectUrl] - Object URL
 * @param {object} params.rawJson - Full activity JSON-LD
 */
export async function enqueueActivity(collections, { activityType, actorUrl, objectUrl, rawJson }) {
  const { ap_inbox_queue } = collections;
  if (!ap_inbox_queue) return;

  await ap_inbox_queue.insertOne({
    activityType,
    actorUrl: actorUrl || "",
    objectUrl: objectUrl || "",
    rawJson,
    status: "pending",
    attempts: 0,
    maxAttempts: 3,
    receivedAt: new Date().toISOString(),
    processedAt: null,
    error: null,
  });
}

/**
 * Start the background inbox processor.
 * @param {object} collections - MongoDB collections
 * @param {Function} getCtx - Function returning a Fedify context
 * @param {string} handle - Our actor handle
 * @returns {NodeJS.Timeout} Interval ID (for cleanup)
 */
export function startInboxProcessor(collections, getCtx, handle) {
  const intervalId = setInterval(async () => {
    try {
      const ctx = getCtx();
      if (ctx) {
        await processNextItem(collections, ctx, handle);
      }
    } catch (error) {
      console.error("[inbox-queue] Processor error:", error.message);
    }
  }, 3_000); // Every 3 seconds

  console.info("[ActivityPub] Inbox queue processor started (3s interval)");
  return intervalId;
}
