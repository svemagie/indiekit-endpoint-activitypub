/**
 * JSON API timeline endpoint — returns pre-rendered HTML cards for infinite scroll AJAX loads.
 */

import { getTimelineItems, countNewItems, markItemsRead } from "../storage/timeline.js";
import { getToken, validateToken } from "../csrf.js";
import { postProcessItems, applyTabFilter, loadModerationData, renderItemCards } from "../item-processing.js";

export function apiTimelineController(mountPath) {
  return async (request, response, next) => {
    try {
      const { application } = request.app.locals;
      const collections = {
        ap_timeline: application?.collections?.get("ap_timeline"),
      };

      // Query parameters
      const tab = request.query.tab || "notes";
      const tag = typeof request.query.tag === "string" ? request.query.tag.trim() : "";
      const before = request.query.before;
      const limit = 20;

      // Build storage query options
      const unread = request.query.unread === "1";
      const options = { before, limit, unread };

      if (tag) {
        options.tag = tag;
      } else {
        if (tab === "notes") {
          options.type = "note";
          options.excludeReplies = true;
        } else if (tab === "articles") {
          options.type = "article";
        } else if (tab === "boosts") {
          options.type = "boost";
        }
      }

      const result = await getTimelineItems(collections, options);

      // Tab filtering for types not supported by storage layer
      const tabFiltered = tag ? result.items : applyTabFilter(result.items, tab);

      // Shared processing pipeline: moderation, quote stripping, interactions
      const modCollections = {
        ap_muted: application?.collections?.get("ap_muted"),
        ap_blocked: application?.collections?.get("ap_blocked"),
        ap_profile: application?.collections?.get("ap_profile"),
      };
      const moderation = await loadModerationData(modCollections);

      const { items, interactionMap } = await postProcessItems(tabFiltered, {
        moderation,
        interactionsCol: application?.collections?.get("ap_interactions"),
      });

      const csrfToken = getToken(request.session);
      const html = await renderItemCards(items, request, {
        ...response.locals,
        mountPath,
        csrfToken,
        interactionMap,
      });

      response.json({
        html,
        before: result.before,
      });
    } catch (error) {
      next(error);
    }
  };
}

/**
 * GET /admin/reader/api/timeline/count-new — count items newer than a given date.
 */
export function countNewController() {
  return async (request, response, next) => {
    try {
      const { application } = request.app.locals;
      const collections = {
        ap_timeline: application?.collections?.get("ap_timeline"),
      };

      const after = request.query.after;
      const tab = request.query.tab || "notes";

      const options = {};
      if (tab === "notes") {
        options.type = "note";
        options.excludeReplies = true;
      } else if (tab === "articles") {
        options.type = "article";
      } else if (tab === "boosts") {
        options.type = "boost";
      }

      const count = await countNewItems(collections, after, options);
      response.json({ count });
    } catch (error) {
      next(error);
    }
  };
}

/**
 * POST /admin/reader/api/timeline/mark-read — mark items as read by UID array.
 */
export function markReadController() {
  return async (request, response, next) => {
    try {
      if (!validateToken(request)) {
        return response.status(403).json({ success: false, error: "Invalid CSRF token" });
      }

      const { uids } = request.body;
      if (!Array.isArray(uids) || uids.length === 0) {
        return response.status(400).json({ success: false, error: "Missing uids array" });
      }

      // Cap batch size to prevent abuse
      const batch = uids.slice(0, 100).filter((uid) => typeof uid === "string");

      const { application } = request.app.locals;
      const collections = {
        ap_timeline: application?.collections?.get("ap_timeline"),
      };

      const updated = await markItemsRead(collections, batch);
      response.json({ success: true, updated });
    } catch (error) {
      next(error);
    }
  };
}
