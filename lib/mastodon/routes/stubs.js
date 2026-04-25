/**
 * Stub and lightweight endpoints for Mastodon Client API.
 *
 * Some endpoints have real implementations (markers, bookmarks, favourites).
 * Others return empty/minimal responses to prevent client errors.
 *
 * Phanpy calls these on startup, navigation, and various page loads:
 * - markers (BackgroundService, every page load)
 * - follow_requests (home + notifications pages)
 * - announcements (notifications page)
 * - custom_emojis (compose screen)
 * - filters (status rendering)
 * - lists (sidebar navigation)
 * - mutes, blocks (nav menu)
 * - featured_tags (profile view)
 * - bookmarks, favourites (dedicated pages)
 * - trends (explore page)
 * - followed_tags (followed tags page)
 * - suggestions (explore page)
 */
import express from "express";
import { serializeStatus } from "../entities/status.js";
import { parseLimit, buildPaginationQuery, setPaginationHeaders } from "../helpers/pagination.js";
import { getFollowedTagsWithState } from "../../storage/followed-tags.js";
import { tokenRequired } from "../middleware/token-required.js";
import { scopeRequired } from "../middleware/scope-required.js";

const router = express.Router(); // eslint-disable-line new-cap

// ─── Markers ────────────────────────────────────────────────────────────────

router.get("/api/v1/markers", async (req, res, next) => {
  try {
    const collections = req.app.locals.mastodonCollections;
    const timelines = [].concat(req.query["timeline[]"] || req.query.timeline || []);

    if (!timelines.length || !collections.ap_markers) {
      return res.json({});
    }

    const docs = await collections.ap_markers
      .find({ timeline: { $in: timelines } })
      .toArray();

    const result = {};
    for (const doc of docs) {
      result[doc.timeline] = {
        last_read_id: doc.last_read_id,
        version: doc.version || 0,
        updated_at: doc.updated_at || new Date().toISOString(),
      };
    }

    res.json(result);
  } catch (error) {
    next(error);
  }
});

router.post("/api/v1/markers", async (req, res, next) => {
  try {
    const collections = req.app.locals.mastodonCollections;
    if (!collections.ap_markers) {
      return res.json({});
    }

    const result = {};
    for (const timeline of ["home", "notifications"]) {
      const data = req.body[timeline];
      if (!data?.last_read_id) continue;

      const now = new Date().toISOString();
      await collections.ap_markers.updateOne(
        { timeline },
        {
          $set: { last_read_id: data.last_read_id, updated_at: now },
          $inc: { version: 1 },
          $setOnInsert: { timeline },
        },
        { upsert: true },
      );

      const doc = await collections.ap_markers.findOne({ timeline });
      result[timeline] = {
        last_read_id: doc.last_read_id,
        version: doc.version || 0,
        updated_at: doc.updated_at || now,
      };
    }

    res.json(result);
  } catch (error) {
    next(error);
  }
});

// ─── Follow requests ────────────────────────────────────────────────────────

router.get("/api/v1/follow_requests", (req, res) => {
  res.json([]);
});

// ─── Announcements ──────────────────────────────────────────────────────────

router.get("/api/v1/announcements", (req, res) => {
  res.json([]);
});

// ─── Custom emojis ──────────────────────────────────────────────────────────

router.get("/api/v1/custom_emojis", (req, res) => {
  res.json([]);
});

// ─── Lists ──────────────────────────────────────────────────────────────────

router.get("/api/v1/lists", (req, res) => {
  res.json([]);
});

// ─── Mutes ──────────────────────────────────────────────────────────────────

router.get("/api/v1/mutes", (req, res) => {
  res.json([]);
});

// ─── Blocks ─────────────────────────────────────────────────────────────────

router.get("/api/v1/blocks", (req, res) => {
  res.json([]);
});

// ─── Bookmarks ──────────────────────────────────────────────────────────────

router.get("/api/v1/bookmarks", async (req, res, next) => {
  try {
    const collections = req.app.locals.mastodonCollections;
    const baseUrl = `${req.protocol}://${req.get("host")}`;
    const limit = parseLimit(req.query.limit);

    if (!collections.ap_interactions) {
      return res.json([]);
    }

    const baseFilter = { type: "bookmark" };
    const { filter, sort, reverse } = buildPaginationQuery(baseFilter, {
      max_id: req.query.max_id,
      min_id: req.query.min_id,
      since_id: req.query.since_id,
    });

    let interactions = await collections.ap_interactions
      .find(filter)
      .sort(sort)
      .limit(limit)
      .toArray();

    if (reverse) interactions.reverse();

    // Batch-fetch the actual timeline items
    const objectUrls = interactions.map((i) => i.objectUrl).filter(Boolean);
    if (!objectUrls.length) {
      return res.json([]);
    }

    const items = await collections.ap_timeline
      .find({ $or: [{ uid: { $in: objectUrls } }, { url: { $in: objectUrls } }] })
      .toArray();

    const itemMap = new Map();
    for (const item of items) {
      if (item.uid) itemMap.set(item.uid, item);
      if (item.url) itemMap.set(item.url, item);
    }

    const statuses = [];
    for (const interaction of interactions) {
      const item = itemMap.get(interaction.objectUrl);
      if (item) {
        statuses.push(
          serializeStatus(item, {
            baseUrl,
            favouritedIds: new Set(),
            rebloggedIds: new Set(),
            bookmarkedIds: new Set([item.uid]),
            pinnedIds: new Set(),
          }),
        );
      }
    }

    setPaginationHeaders(res, req, interactions, limit);
    res.json(statuses);
  } catch (error) {
    next(error);
  }
});

// ─── Favourites ─────────────────────────────────────────────────────────────

router.get("/api/v1/favourites", async (req, res, next) => {
  try {
    const collections = req.app.locals.mastodonCollections;
    const baseUrl = `${req.protocol}://${req.get("host")}`;
    const limit = parseLimit(req.query.limit);

    if (!collections.ap_interactions) {
      return res.json([]);
    }

    const baseFilter = { type: "like" };
    const { filter, sort, reverse } = buildPaginationQuery(baseFilter, {
      max_id: req.query.max_id,
      min_id: req.query.min_id,
      since_id: req.query.since_id,
    });

    let interactions = await collections.ap_interactions
      .find(filter)
      .sort(sort)
      .limit(limit)
      .toArray();

    if (reverse) interactions.reverse();

    const objectUrls = interactions.map((i) => i.objectUrl).filter(Boolean);
    if (!objectUrls.length) {
      return res.json([]);
    }

    const items = await collections.ap_timeline
      .find({ $or: [{ uid: { $in: objectUrls } }, { url: { $in: objectUrls } }] })
      .toArray();

    const itemMap = new Map();
    for (const item of items) {
      if (item.uid) itemMap.set(item.uid, item);
      if (item.url) itemMap.set(item.url, item);
    }

    const statuses = [];
    for (const interaction of interactions) {
      const item = itemMap.get(interaction.objectUrl);
      if (item) {
        statuses.push(
          serializeStatus(item, {
            baseUrl,
            favouritedIds: new Set([item.uid]),
            rebloggedIds: new Set(),
            bookmarkedIds: new Set(),
            pinnedIds: new Set(),
          }),
        );
      }
    }

    setPaginationHeaders(res, req, interactions, limit);
    res.json(statuses);
  } catch (error) {
    next(error);
  }
});

// ─── Featured tags ──────────────────────────────────────────────────────────

router.get("/api/v1/featured_tags", (req, res) => {
  res.json([]);
});

// ─── Followed tags ──────────────────────────────────────────────────────────

router.get("/api/v1/followed_tags", async (req, res, next) => {
  try {
    const collections = req.app.locals.mastodonCollections;
    if (!collections?.ap_followed_tags) {
      return res.json([]);
    }

    const pluginOptions = req.app.locals.mastodonPluginOptions || {};
    const publicationUrl = pluginOptions.publicationUrl || "";
    const tags = await getFollowedTagsWithState({ ap_followed_tags: collections.ap_followed_tags });

    const response = tags.map((doc) => ({
      id: doc._id.toString(),
      name: doc.tag,
      url: `${publicationUrl.replace(/\/$/, "")}/tags/${doc.tag}`,
      history: [],
      following: true,
    }));

    res.json(response);
  } catch (error) {
    next(error);
  }
});

// ─── GET /api/v1/tags/:id ───────────────────────────────────────────────────

router.get("/api/v1/tags/:id", async (req, res) => {
  const collections = req.app.locals.mastodonCollections;
  const tag = req.params.id.toLowerCase().replace(/^#/, "");
  let following = false;

  if (collections.ap_followed_tags) {
    const doc = await collections.ap_followed_tags.findOne({ tag });
    following = !!doc;
  }

  res.json({
    name: tag,
    url: `${req.protocol}://${req.get("host")}/tags/${tag}`,
    history: [],
    following,
  });
});

// ─── POST /api/v1/tags/:id/follow ──────────────────────────────────────────

router.post("/api/v1/tags/:id/follow", tokenRequired, scopeRequired("write", "write:follows"), async (req, res) => {
  const collections = req.app.locals.mastodonCollections;
  const tag = req.params.id.toLowerCase().replace(/^#/, "");

  if (collections.ap_followed_tags) {
    await collections.ap_followed_tags.updateOne(
      { tag },
      { $setOnInsert: { tag, createdAt: new Date().toISOString() } },
      { upsert: true },
    );
  }

  res.json({
    name: tag,
    url: `${req.protocol}://${req.get("host")}/tags/${tag}`,
    history: [],
    following: true,
  });
});

// ─── POST /api/v1/tags/:id/unfollow ────────────────────────────────────────

router.post("/api/v1/tags/:id/unfollow", tokenRequired, scopeRequired("write", "write:follows"), async (req, res) => {
  const collections = req.app.locals.mastodonCollections;
  const tag = req.params.id.toLowerCase().replace(/^#/, "");

  if (collections.ap_followed_tags) {
    await collections.ap_followed_tags.deleteOne({ tag });
  }

  res.json({
    name: tag,
    url: `${req.protocol}://${req.get("host")}/tags/${tag}`,
    history: [],
    following: false,
  });
});

// ─── Suggestions ────────────────────────────────────────────────────────────

router.get("/api/v2/suggestions", (req, res) => {
  res.json([]);
});

// ─── Trends ─────────────────────────────────────────────────────────────────

router.get("/api/v1/trends/statuses", (req, res) => {
  res.json([]);
});

router.get("/api/v1/trends/tags", (req, res) => {
  res.json([]);
});

router.get("/api/v1/trends/links", (req, res) => {
  res.json([]);
});

// ─── Scheduled statuses ─────────────────────────────────────────────────────

router.get("/api/v1/scheduled_statuses", (req, res) => {
  res.json([]);
});

// ─── Conversations ──────────────────────────────────────────────────────────

// ─── Conversations (Direct Messages) ────────────────────────────────────────
// Real implementation replacing the empty stub.
// Reads from ap_messages collection, groups by conversationId (actor URL).

router.get("/api/v1/conversations", async (req, res, next) => {
  try {
    const collections = req.app.locals.mastodonCollections;
    const baseUrl = `${req.protocol}://${req.get("host")}`;
    const { serializeAccount } = await import("../entities/account.js");
    const { remoteActorId } = await import("../helpers/id-mapping.js");
    const { parseLimit } = await import("../helpers/pagination.js");
    if (!collections?.ap_messages) {
      return res.json([]);
    }
    const limit = parseLimit(req.query.limit, 20);
    // Aggregate conversations: group by conversationId, get last message + unread count
    const pipeline = [
      { $sort: { published: -1 } },
      {
        $group: {
          _id: "$conversationId",
          lastMessageId: { $first: "$_id" },
          lastUid: { $first: "$uid" },
          lastContent: { $first: "$content" },
          lastPublished: { $first: "$published" },
          actorUrl: { $first: "$actorUrl" },
          actorName: { $first: "$actorName" },
          actorPhoto: { $first: "$actorPhoto" },
          actorHandle: { $first: "$actorHandle" },
          unreadCount: {
            $sum: { $cond: [{ $eq: ["$read", false] }, 1, 0] },
          },
        },
      },
      { $sort: { lastPublished: -1 } },
    ];
    // Apply cursor pagination on the aggregation result
    if (req.query.max_id) {
      pipeline.splice(0, 0, {
        $match: { _id: { $lt: req.query.max_id } },
      });
    }
    pipeline.push({ $limit: limit });
    const conversations = await collections.ap_messages
      .aggregate(pipeline)
      .toArray();
    const result = conversations.map((conv) => {
      const convId = remoteActorId(conv._id || conv.actorUrl);
      // Build a minimal Mastodon Status for last_status
      const lastStatus = {
        id: conv.lastMessageId.toString(),
        created_at: conv.lastPublished || new Date().toISOString(),
        in_reply_to_id: null,
        in_reply_to_account_id: null,
        sensitive: false,
        spoiler_text: "",
        visibility: "direct",
        language: null,
        uri: conv.lastUid || "",
        url: conv.lastUid || "",
        replies_count: 0,
        reblogs_count: 0,
        favourites_count: 0,
        edited_at: null,
        favourited: false,
        reblogged: false,
        muted: false,
        bookmarked: false,
        pinned: false,
        content: conv.lastContent?.html || conv.lastContent?.text || "",
        filtered: null,
        reblog: null,
        application: null,
        account: serializeAccount(
          {
            name: conv.actorName,
            url: conv.actorUrl,
            photo: conv.actorPhoto,
            handle: conv.actorHandle,
          },
          { baseUrl },
        ),
        media_attachments: [],
        mentions: [],
        tags: [],
        emojis: [],
        card: null,
        poll: null,
      };
      return {
        id: convId,
        unread: conv.unreadCount > 0,
        last_status: lastStatus,
        accounts: [
          serializeAccount(
            {
              name: conv.actorName,
              url: conv.actorUrl,
              photo: conv.actorPhoto,
              handle: conv.actorHandle,
            },
            { baseUrl },
          ),
        ],
      };
    });
    // Set Link header for pagination
    if (result.length === limit && conversations.length > 0) {
      const lastConv = conversations[conversations.length - 1];
      const maxId = remoteActorId(lastConv._id || lastConv.actorUrl);
      res.set("Link", `<${baseUrl}/api/v1/conversations?max_id=${maxId}>; rel="next"`);
    }
    res.json(result);
  } catch (error) {
    next(error);
  }
});

// Mark conversation as read
router.post("/api/v1/conversations/:id/read", async (req, res, next) => {
  try {
    const collections = req.app.locals.mastodonCollections;
    const baseUrl = `${req.protocol}://${req.get("host")}`;
    const { serializeAccount } = await import("../entities/account.js");
    const { remoteActorId } = await import("../helpers/id-mapping.js");
    if (!collections?.ap_messages) {
      return res.status(404).json({ error: "Not found" });
    }
    // Find the conversation partner whose hashed actorUrl matches the :id
    const allPartners = await collections.ap_messages.aggregate([
      { $group: { _id: "$conversationId" } },
    ]).toArray();
    const partner = allPartners.find(
      (p) => remoteActorId(p._id) === req.params.id
    );
    if (!partner) {
      return res.status(404).json({ error: "Conversation not found" });
    }
    // Mark all messages from this partner as read
    await collections.ap_messages.updateMany(
      { conversationId: partner._id, read: false },
      { $set: { read: true } },
    );
    // Return the updated conversation
    const lastMsg = await collections.ap_messages
      .findOne({ conversationId: partner._id }, { sort: { published: -1 } });
    if (!lastMsg) {
      return res.status(404).json({ error: "No messages" });
    }
    const convId = remoteActorId(partner._id);
    const account = serializeAccount(
      {
        name: lastMsg.actorName,
        url: lastMsg.actorUrl,
        photo: lastMsg.actorPhoto,
        handle: lastMsg.actorHandle,
      },
      { baseUrl },
    );
    res.json({
      id: convId,
      unread: false,
      last_status: {
        id: lastMsg._id.toString(),
        created_at: lastMsg.published || new Date().toISOString(),
        in_reply_to_id: null,
        in_reply_to_account_id: null,
        sensitive: false,
        spoiler_text: "",
        visibility: "direct",
        language: null,
        uri: lastMsg.uid || "",
        url: lastMsg.uid || "",
        replies_count: 0,
        reblogs_count: 0,
        favourites_count: 0,
        edited_at: null,
        favourited: false,
        reblogged: false,
        muted: false,
        bookmarked: false,
        pinned: false,
        content: lastMsg.content?.html || lastMsg.content?.text || "",
        filtered: null,
        reblog: null,
        application: null,
        account,
        media_attachments: [],
        mentions: [],
        tags: [],
        emojis: [],
        card: null,
        poll: null,
      },
      accounts: [account],
    });
  } catch (error) {
    next(error);
  }
});

// ─── Domain blocks ──────────────────────────────────────────────────────────

router.get("/api/v1/domain_blocks", async (req, res) => {
  try {
    const collections = req.app.locals.mastodonCollections;
    if (!collections?.ap_blocked_servers) return res.json([]);
    const docs = await collections.ap_blocked_servers.find({}).toArray();
    res.json(docs.map((d) => d.hostname).filter(Boolean));
  } catch {
    res.json([]);
  }
});

// ─── POST /api/v1/domain_blocks ─────────────────────────────────────────────

router.post("/api/v1/domain_blocks", tokenRequired, scopeRequired("write", "write:blocks"), async (req, res, next) => {
  try {
    const collections = req.app.locals.mastodonCollections;
    const domain = req.body.domain?.trim();

    if (!domain) {
      return res.status(422).json({ error: "domain is required" });
    }

    if (collections.ap_blocked_servers) {
      await collections.ap_blocked_servers.updateOne(
        { hostname: domain },
        { $setOnInsert: { hostname: domain, createdAt: new Date().toISOString() } },
        { upsert: true },
      );
    }

    res.json({});
  } catch (error) {
    next(error);
  }
});

// ─── DELETE /api/v1/domain_blocks ───────────────────────────────────────────

router.delete("/api/v1/domain_blocks", tokenRequired, scopeRequired("write", "write:blocks"), async (req, res, next) => {
  try {
    const collections = req.app.locals.mastodonCollections;
    const domain = req.body.domain?.trim();

    if (domain && collections.ap_blocked_servers) {
      await collections.ap_blocked_servers.deleteOne({ hostname: domain });
    }

    res.json({});
  } catch (error) {
    next(error);
  }
});

// ─── Endorsements ───────────────────────────────────────────────────────────

router.get("/api/v1/endorsements", (req, res) => {
  res.json([]);
});




export default router;
