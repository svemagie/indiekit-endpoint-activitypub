/**
 * Outbox backfill — fetch recent posts from a remote actor's outbox
 * and store them in the local ap_timeline after a follow.
 *
 * Runs asynchronously (fire-and-forget) — never blocks followActor().
 * Fetches at most one page (limit 20) from the outbox's `first` page.
 * Uses extractObjectData() from timeline-store for consistent normalization.
 */

import { Note, Article, Create, Announce } from "@fedify/fedify/vocab";
import { extractObjectData } from "./timeline-store.js";
import { addTimelineItem } from "./storage/timeline.js";

/**
 * Fetch up to `limit` recent posts from `actorUrl`'s AP outbox and
 * store them in ap_timeline. Non-blocking — call without await.
 *
 * @param {object} options
 * @param {string} options.actorUrl - Remote actor AP URL
 * @param {object} options.remoteActor - Resolved Fedify actor object
 * @param {object} options.ctx - Fedify context (for documentLoader)
 * @param {string} options.handle - Local actor handle (for signed fetches)
 * @param {object} options.collections - MongoDB collections
 * @param {number} [options.limit=20] - Max posts to backfill
 */
export async function backfillFromOutbox({ actorUrl, remoteActor, ctx, handle, collections, limit = 20 }) {
  if (!collections?.ap_timeline) return;

  try {
    const documentLoader = await ctx.getDocumentLoader({ identifier: handle });

    // Fetch outbox collection
    const outbox = await remoteActor.getOutbox({ documentLoader }).catch(() => null);
    if (!outbox) return;

    // Collect activity items — try direct items first, then first-page
    const activities = [];
    let itemSource = null;
    try {
      // Some servers return a directly-iterable collection without pagination
      const direct = outbox.getItems?.({ documentLoader });
      if (direct) itemSource = direct;
    } catch { /* not directly iterable */ }

    if (!itemSource) {
      // Paginated — navigate to first page
      const firstPage = await outbox.getFirst({ documentLoader }).catch(() => null);
      if (firstPage?.getItems) itemSource = firstPage.getItems({ documentLoader });
    }

    if (!itemSource) return;

    try {
      for await (const item of itemSource) {
        activities.push(item);
        if (activities.length >= limit) break;
      }
    } catch {
      // Partial read is fine — use what we got
    }

    if (activities.length === 0) return;

    let stored = 0;
    for (const activity of activities) {
      try {
        // Only handle Create(Note/Article) and Announce activities
        let object = null;
        let boostedBy = null;

        if (activity instanceof Create) {
          object = await activity.getObject({ documentLoader }).catch(() => null);
        } else if (activity instanceof Announce) {
          object = await activity.getObject({ documentLoader }).catch(() => null);
          if (object) {
            // For boosts: actor info comes from the remote actor we just followed
            boostedBy = {
              name: remoteActor.name?.toString() || remoteActor.preferredUsername?.toString() || "",
              url: actorUrl,
              photo: "",
              handle: "",
            };
          }
        }

        if (!object || !(object instanceof Note || object instanceof Article)) continue;

        const uid = object.id?.href;
        if (!uid) continue;

        // Skip if already in timeline
        const exists = await collections.ap_timeline.findOne({ uid }, { projection: { _id: 1 } });
        if (exists) continue;

        const item = await extractObjectData(object, {
          documentLoader,
          actorFallback: remoteActor,
          boostedBy,
          boostedAt: boostedBy ? new Date().toISOString() : undefined,
        });

        // Ensure visibility field (extractObjectData doesn't set it)
        if (!item.visibility) item.visibility = "public";

        await addTimelineItem({ ap_timeline: collections.ap_timeline }, item);
        stored++;
      } catch {
        // Skip individual item errors — keep going
      }
    }

    if (stored > 0) {
      console.info(`[ActivityPub] Outbox backfill: stored ${stored} posts from ${actorUrl}`);
    }
  } catch (error) {
    console.warn(`[ActivityPub] Outbox backfill failed for ${actorUrl}:`, error?.message);
  }
}
