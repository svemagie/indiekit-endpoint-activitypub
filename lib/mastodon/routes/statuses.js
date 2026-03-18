/**
 * Status endpoints for Mastodon Client API.
 *
 * GET /api/v1/statuses/:id — single status
 * GET /api/v1/statuses/:id/context — thread context (ancestors + descendants)
 * POST /api/v1/statuses/:id/favourite — like a post
 * POST /api/v1/statuses/:id/unfavourite — unlike a post
 * POST /api/v1/statuses/:id/reblog — boost a post
 * POST /api/v1/statuses/:id/unreblog — unboost a post
 * POST /api/v1/statuses/:id/bookmark — bookmark a post
 * POST /api/v1/statuses/:id/unbookmark — remove bookmark
 */
import express from "express";
import { ObjectId } from "mongodb";
import { serializeStatus } from "../entities/status.js";
import { serializeAccount } from "../entities/account.js";
import {
  likePost, unlikePost,
  boostPost, unboostPost,
  bookmarkPost, unbookmarkPost,
} from "../helpers/interactions.js";

const router = express.Router(); // eslint-disable-line new-cap

// ─── GET /api/v1/statuses/:id ───────────────────────────────────────────────

router.get("/api/v1/statuses/:id", async (req, res, next) => {
  try {
    const { id } = req.params;
    const collections = req.app.locals.mastodonCollections;
    const baseUrl = `${req.protocol}://${req.get("host")}`;

    let objectId;
    try {
      objectId = new ObjectId(id);
    } catch {
      return res.status(404).json({ error: "Record not found" });
    }

    const item = await collections.ap_timeline.findOne({ _id: objectId });
    if (!item) {
      return res.status(404).json({ error: "Record not found" });
    }

    // Load interaction state if authenticated
    const interactionState = await loadItemInteractions(collections, item);

    const status = serializeStatus(item, {
      baseUrl,
      ...interactionState,
      pinnedIds: new Set(),
    });

    res.json(status);
  } catch (error) {
    next(error);
  }
});

// ─── GET /api/v1/statuses/:id/context ───────────────────────────────────────

router.get("/api/v1/statuses/:id/context", async (req, res, next) => {
  try {
    const { id } = req.params;
    const collections = req.app.locals.mastodonCollections;
    const baseUrl = `${req.protocol}://${req.get("host")}`;

    let objectId;
    try {
      objectId = new ObjectId(id);
    } catch {
      return res.status(404).json({ error: "Record not found" });
    }

    const item = await collections.ap_timeline.findOne({ _id: objectId });
    if (!item) {
      return res.status(404).json({ error: "Record not found" });
    }

    // Find ancestors: walk up the inReplyTo chain
    const ancestors = [];
    let currentReplyTo = item.inReplyTo;
    const visited = new Set();

    while (currentReplyTo && ancestors.length < 40) {
      if (visited.has(currentReplyTo)) break;
      visited.add(currentReplyTo);

      const parent = await collections.ap_timeline.findOne({
        $or: [{ uid: currentReplyTo }, { url: currentReplyTo }],
      });
      if (!parent) break;

      ancestors.unshift(parent);
      currentReplyTo = parent.inReplyTo;
    }

    // Find descendants: items that reply to this post's uid or url
    const targetUrls = [item.uid, item.url].filter(Boolean);
    let descendants = [];

    if (targetUrls.length > 0) {
      // Get direct replies first
      const directReplies = await collections.ap_timeline
        .find({ inReplyTo: { $in: targetUrls } })
        .sort({ _id: 1 })
        .limit(60)
        .toArray();

      descendants = directReplies;

      // Also fetch replies to direct replies (2 levels deep)
      if (directReplies.length > 0) {
        const replyUrls = directReplies
          .flatMap((r) => [r.uid, r.url].filter(Boolean));
        const nestedReplies = await collections.ap_timeline
          .find({ inReplyTo: { $in: replyUrls } })
          .sort({ _id: 1 })
          .limit(60)
          .toArray();
        descendants.push(...nestedReplies);
      }
    }

    // Serialize all items
    const emptyInteractions = {
      favouritedIds: new Set(),
      rebloggedIds: new Set(),
      bookmarkedIds: new Set(),
      pinnedIds: new Set(),
    };

    const serializeOpts = { baseUrl, ...emptyInteractions };

    res.json({
      ancestors: ancestors.map((a) => serializeStatus(a, serializeOpts)),
      descendants: descendants.map((d) => serializeStatus(d, serializeOpts)),
    });
  } catch (error) {
    next(error);
  }
});

// ─── POST /api/v1/statuses ───────────────────────────────────────────────────

router.post("/api/v1/statuses", async (req, res, next) => {
  try {
    const token = req.mastodonToken;
    if (!token) {
      return res.status(401).json({ error: "The access token is invalid" });
    }

    const collections = req.app.locals.mastodonCollections;
    const pluginOptions = req.app.locals.mastodonPluginOptions || {};
    const baseUrl = `${req.protocol}://${req.get("host")}`;

    const {
      status: statusText,
      spoiler_text: spoilerText,
      visibility = "public",
      sensitive = false,
      language,
      in_reply_to_id: inReplyToId,
      media_ids: mediaIds,
    } = req.body;

    if (!statusText && (!mediaIds || mediaIds.length === 0)) {
      return res.status(422).json({ error: "Validation failed: Text content is required" });
    }

    // Resolve in_reply_to if provided
    let inReplyTo = null;
    if (inReplyToId) {
      try {
        const replyItem = await collections.ap_timeline.findOne({
          _id: new ObjectId(inReplyToId),
        });
        if (replyItem) {
          inReplyTo = replyItem.uid || replyItem.url;
        }
      } catch {
        // Invalid ObjectId — ignore
      }
    }

    // Load local profile for the author field
    const profile = await collections.ap_profile.findOne({});
    const handle = pluginOptions.handle || "user";
    const publicationUrl = pluginOptions.publicationUrl || baseUrl;
    const actorUrl = profile?.url || `${publicationUrl}/users/${handle}`;

    // Generate post ID and URL
    const postId = crypto.randomUUID();
    const postUrl = `${publicationUrl.replace(/\/$/, "")}/posts/${postId}`;
    const uid = postUrl;

    // Build the timeline item
    const now = new Date().toISOString();
    const timelineItem = {
      uid,
      url: postUrl,
      type: "note",
      content: {
        text: statusText || "",
        html: linkifyAndParagraph(statusText || ""),
      },
      summary: spoilerText || "",
      sensitive: sensitive === true || sensitive === "true",
      visibility: visibility || "public",
      language: language || null,
      inReplyTo,
      published: now,
      createdAt: now,
      author: {
        name: profile?.name || handle,
        url: actorUrl,
        photo: profile?.icon || "",
        handle: `@${handle}`,
        emojis: [],
        bot: false,
      },
      photo: [],
      video: [],
      audio: [],
      category: extractHashtags(statusText || ""),
      counts: { replies: 0, boosts: 0, likes: 0 },
      linkPreviews: [],
      mentions: [],
      emojis: [],
    };

    // Insert into timeline
    const result = await collections.ap_timeline.insertOne(timelineItem);
    timelineItem._id = result.insertedId;

    // Trigger federation asynchronously (don't block the response)
    if (pluginOptions.federation) {
      federatePost(timelineItem, pluginOptions).catch((err) => {
        console.error("[Mastodon API] Federation failed:", err.message);
      });
    }

    // Serialize and return
    const serialized = serializeStatus(timelineItem, {
      baseUrl,
      favouritedIds: new Set(),
      rebloggedIds: new Set(),
      bookmarkedIds: new Set(),
      pinnedIds: new Set(),
    });

    res.json(serialized);
  } catch (error) {
    next(error);
  }
});

// ─── DELETE /api/v1/statuses/:id ────────────────────────────────────────────

router.delete("/api/v1/statuses/:id", async (req, res, next) => {
  try {
    const token = req.mastodonToken;
    if (!token) {
      return res.status(401).json({ error: "The access token is invalid" });
    }

    const { id } = req.params;
    const collections = req.app.locals.mastodonCollections;
    const baseUrl = `${req.protocol}://${req.get("host")}`;

    let objectId;
    try {
      objectId = new ObjectId(id);
    } catch {
      return res.status(404).json({ error: "Record not found" });
    }

    const item = await collections.ap_timeline.findOne({ _id: objectId });
    if (!item) {
      return res.status(404).json({ error: "Record not found" });
    }

    // Verify ownership — only allow deleting own posts
    const profile = await collections.ap_profile.findOne({});
    if (profile && item.author?.url !== profile.url) {
      return res.status(403).json({ error: "This action is not allowed" });
    }

    // Serialize before deleting (Mastodon returns the deleted status with text source)
    const serialized = serializeStatus(item, {
      baseUrl,
      favouritedIds: new Set(),
      rebloggedIds: new Set(),
      bookmarkedIds: new Set(),
      pinnedIds: new Set(),
    });
    serialized.text = item.content?.text || "";

    // Delete from timeline
    await collections.ap_timeline.deleteOne({ _id: objectId });

    // Clean up interactions
    if (collections.ap_interactions && item.uid) {
      await collections.ap_interactions.deleteMany({ objectUrl: item.uid });
    }

    // TODO: Broadcast Delete activity via federation

    res.json(serialized);
  } catch (error) {
    next(error);
  }
});

// ─── GET /api/v1/statuses/:id/favourited_by ─────────────────────────────────

router.get("/api/v1/statuses/:id/favourited_by", async (req, res) => {
  // Stub — we don't track who favourited remotely
  res.json([]);
});

// ─── GET /api/v1/statuses/:id/reblogged_by ──────────────────────────────────

router.get("/api/v1/statuses/:id/reblogged_by", async (req, res) => {
  // Stub — we don't track who boosted remotely
  res.json([]);
});

// ─── POST /api/v1/statuses/:id/favourite ────────────────────────────────────

router.post("/api/v1/statuses/:id/favourite", async (req, res, next) => {
  try {
    const token = req.mastodonToken;
    if (!token) {
      return res.status(401).json({ error: "The access token is invalid" });
    }

    const { item, collections, baseUrl } = await resolveStatusForInteraction(req);
    if (!item) {
      return res.status(404).json({ error: "Record not found" });
    }

    const opts = getFederationOpts(req);
    await likePost({
      targetUrl: item.uid || item.url,
      ...opts,
      interactions: collections.ap_interactions,
    });

    const interactionState = await loadItemInteractions(collections, item);
    // Force favourited=true since we just liked it
    interactionState.favouritedIds.add(item.uid);

    res.json(serializeStatus(item, { baseUrl, ...interactionState, pinnedIds: new Set() }));
  } catch (error) {
    next(error);
  }
});

// ─── POST /api/v1/statuses/:id/unfavourite ──────────────────────────────────

router.post("/api/v1/statuses/:id/unfavourite", async (req, res, next) => {
  try {
    const token = req.mastodonToken;
    if (!token) {
      return res.status(401).json({ error: "The access token is invalid" });
    }

    const { item, collections, baseUrl } = await resolveStatusForInteraction(req);
    if (!item) {
      return res.status(404).json({ error: "Record not found" });
    }

    const opts = getFederationOpts(req);
    await unlikePost({
      targetUrl: item.uid || item.url,
      ...opts,
      interactions: collections.ap_interactions,
    });

    const interactionState = await loadItemInteractions(collections, item);
    interactionState.favouritedIds.delete(item.uid);

    res.json(serializeStatus(item, { baseUrl, ...interactionState, pinnedIds: new Set() }));
  } catch (error) {
    next(error);
  }
});

// ─── POST /api/v1/statuses/:id/reblog ───────────────────────────────────────

router.post("/api/v1/statuses/:id/reblog", async (req, res, next) => {
  try {
    const token = req.mastodonToken;
    if (!token) {
      return res.status(401).json({ error: "The access token is invalid" });
    }

    const { item, collections, baseUrl } = await resolveStatusForInteraction(req);
    if (!item) {
      return res.status(404).json({ error: "Record not found" });
    }

    const opts = getFederationOpts(req);
    await boostPost({
      targetUrl: item.uid || item.url,
      ...opts,
      interactions: collections.ap_interactions,
    });

    const interactionState = await loadItemInteractions(collections, item);
    interactionState.rebloggedIds.add(item.uid);

    res.json(serializeStatus(item, { baseUrl, ...interactionState, pinnedIds: new Set() }));
  } catch (error) {
    next(error);
  }
});

// ─── POST /api/v1/statuses/:id/unreblog ─────────────────────────────────────

router.post("/api/v1/statuses/:id/unreblog", async (req, res, next) => {
  try {
    const token = req.mastodonToken;
    if (!token) {
      return res.status(401).json({ error: "The access token is invalid" });
    }

    const { item, collections, baseUrl } = await resolveStatusForInteraction(req);
    if (!item) {
      return res.status(404).json({ error: "Record not found" });
    }

    const opts = getFederationOpts(req);
    await unboostPost({
      targetUrl: item.uid || item.url,
      ...opts,
      interactions: collections.ap_interactions,
    });

    const interactionState = await loadItemInteractions(collections, item);
    interactionState.rebloggedIds.delete(item.uid);

    res.json(serializeStatus(item, { baseUrl, ...interactionState, pinnedIds: new Set() }));
  } catch (error) {
    next(error);
  }
});

// ─── POST /api/v1/statuses/:id/bookmark ─────────────────────────────────────

router.post("/api/v1/statuses/:id/bookmark", async (req, res, next) => {
  try {
    const token = req.mastodonToken;
    if (!token) {
      return res.status(401).json({ error: "The access token is invalid" });
    }

    const { item, collections, baseUrl } = await resolveStatusForInteraction(req);
    if (!item) {
      return res.status(404).json({ error: "Record not found" });
    }

    await bookmarkPost({
      targetUrl: item.uid || item.url,
      interactions: collections.ap_interactions,
    });

    const interactionState = await loadItemInteractions(collections, item);
    interactionState.bookmarkedIds.add(item.uid);

    res.json(serializeStatus(item, { baseUrl, ...interactionState, pinnedIds: new Set() }));
  } catch (error) {
    next(error);
  }
});

// ─── POST /api/v1/statuses/:id/unbookmark ───────────────────────────────────

router.post("/api/v1/statuses/:id/unbookmark", async (req, res, next) => {
  try {
    const token = req.mastodonToken;
    if (!token) {
      return res.status(401).json({ error: "The access token is invalid" });
    }

    const { item, collections, baseUrl } = await resolveStatusForInteraction(req);
    if (!item) {
      return res.status(404).json({ error: "Record not found" });
    }

    await unbookmarkPost({
      targetUrl: item.uid || item.url,
      interactions: collections.ap_interactions,
    });

    const interactionState = await loadItemInteractions(collections, item);
    interactionState.bookmarkedIds.delete(item.uid);

    res.json(serializeStatus(item, { baseUrl, ...interactionState, pinnedIds: new Set() }));
  } catch (error) {
    next(error);
  }
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Resolve a timeline item from the :id param, plus common context.
 */
async function resolveStatusForInteraction(req) {
  const collections = req.app.locals.mastodonCollections;
  const baseUrl = `${req.protocol}://${req.get("host")}`;

  let objectId;
  try {
    objectId = new ObjectId(req.params.id);
  } catch {
    return { item: null, collections, baseUrl };
  }

  const item = await collections.ap_timeline.findOne({ _id: objectId });
  return { item, collections, baseUrl };
}

/**
 * Build federation options from request context for interaction helpers.
 */
function getFederationOpts(req) {
  const pluginOptions = req.app.locals.mastodonPluginOptions || {};
  return {
    federation: pluginOptions.federation,
    handle: pluginOptions.handle || "user",
    publicationUrl: pluginOptions.publicationUrl,
    collections: req.app.locals.mastodonCollections,
  };
}

async function loadItemInteractions(collections, item) {
  const favouritedIds = new Set();
  const rebloggedIds = new Set();
  const bookmarkedIds = new Set();

  if (!collections.ap_interactions || !item.uid) {
    return { favouritedIds, rebloggedIds, bookmarkedIds };
  }

  const lookupUrls = [item.uid, item.url].filter(Boolean);
  const interactions = await collections.ap_interactions
    .find({ objectUrl: { $in: lookupUrls } })
    .toArray();

  for (const i of interactions) {
    const uid = item.uid;
    if (i.type === "like") favouritedIds.add(uid);
    else if (i.type === "boost") rebloggedIds.add(uid);
    else if (i.type === "bookmark") bookmarkedIds.add(uid);
  }

  return { favouritedIds, rebloggedIds, bookmarkedIds };
}

/**
 * Convert plain text to basic HTML (paragraphs + linkified URLs).
 */
function linkifyAndParagraph(text) {
  if (!text) return "";
  const paragraphs = text.split(/\n\n+/).filter(Boolean);
  return paragraphs
    .map((p) => {
      const withBreaks = p.replace(/\n/g, "<br>");
      const linked = withBreaks.replace(
        /(?<![=">])(https?:\/\/[^\s<"]+)/g,
        '<a href="$1">$1</a>',
      );
      return `<p>${linked}</p>`;
    })
    .join("");
}

/**
 * Extract #hashtags from text content.
 */
function extractHashtags(text) {
  if (!text) return [];
  const tags = [];
  const regex = /#([\w]+)/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    tags.push(match[1]);
  }
  return [...new Set(tags)];
}

/**
 * Federate a newly created post via ActivityPub.
 * Runs asynchronously — errors logged, don't block API response.
 */
async function federatePost(item, pluginOptions) {
  const { jf2ToAS2Activity } = await import("../../jf2-to-as2.js");

  const handle = pluginOptions.handle || "user";
  const publicationUrl = pluginOptions.publicationUrl;
  const federation = pluginOptions.federation;
  const actorUrl = `${publicationUrl.replace(/\/$/, "")}/users/${handle}`;

  const ctx = federation.createContext(
    new URL(publicationUrl),
    { handle, publicationUrl },
  );

  const properties = {
    "post-type": "note",
    url: item.url,
    content: item.content,
    summary: item.summary || undefined,
    "in-reply-to": item.inReplyTo || undefined,
    category: item.category,
    visibility: item.visibility,
  };

  const activity = jf2ToAS2Activity(properties, actorUrl, publicationUrl, {
    visibility: item.visibility,
  });

  if (activity) {
    await ctx.sendActivity({ identifier: handle }, "followers", activity, {
      preferSharedInbox: true,
    });
    console.info(`[Mastodon API] Federated post: ${item.url}`);
  }
}

export default router;
