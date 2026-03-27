/**
 * Status endpoints for Mastodon Client API.
 *
 * GET /api/v1/statuses/:id — single status
 * GET /api/v1/statuses/:id/context — thread context (ancestors + descendants)
 * POST /api/v1/statuses — create post via Micropub pipeline
 * DELETE /api/v1/statuses/:id — delete post via Micropub pipeline
 * POST /api/v1/statuses/:id/favourite — like a post
 * POST /api/v1/statuses/:id/unfavourite — unlike a post
 * POST /api/v1/statuses/:id/reblog — boost a post
 * POST /api/v1/statuses/:id/unreblog — unboost a post
 * POST /api/v1/statuses/:id/bookmark — bookmark a post
 * POST /api/v1/statuses/:id/unbookmark — remove bookmark
 * PUT /api/v1/statuses/:id — edit post content via Micropub pipeline
 * POST /api/v1/statuses/:id/pin — pin post to profile
 * POST /api/v1/statuses/:id/unpin — unpin post from profile
 */
import crypto from "node:crypto";
import express from "express";
import { Note, Create, Mention, Update } from "@fedify/fedify/vocab";
import { ObjectId } from "mongodb";
import { serializeStatus } from "../entities/status.js";
import { decodeCursor } from "../helpers/pagination.js";
import {
  likePost, unlikePost,
  boostPost, unboostPost,
  bookmarkPost, unbookmarkPost,
} from "../helpers/interactions.js";
import { addTimelineItem } from "../../storage/timeline.js";
import { lookupWithSecurity } from "../../lookup-helpers.js";
import { addNotification } from "../../storage/notifications.js";
import { tokenRequired } from "../middleware/token-required.js";
import { scopeRequired } from "../middleware/scope-required.js";

const router = express.Router(); // eslint-disable-line new-cap

// ─── GET /api/v1/statuses/:id ───────────────────────────────────────────────

router.get("/api/v1/statuses/:id", tokenRequired, scopeRequired("read", "read:statuses"), async (req, res, next) => {
  try {
    const { id } = req.params;
    const collections = req.app.locals.mastodonCollections;
    const baseUrl = `${req.protocol}://${req.get("host")}`;

    const item = await findTimelineItemById(collections.ap_timeline, id);
    if (!item) {
      return res.status(404).json({ error: "Record not found" });
    }

    // Load interaction state if authenticated
    const interactionState = await loadItemInteractions(collections, item);

    const status = serializeStatus(item, { baseUrl, ...interactionState });

    res.json(status);
  } catch (error) {
    next(error);
  }
});

// ─── GET /api/v1/statuses/:id/context ───────────────────────────────────────

router.get("/api/v1/statuses/:id/context", tokenRequired, scopeRequired("read", "read:statuses"), async (req, res, next) => {
  try {
    const { id } = req.params;
    const collections = req.app.locals.mastodonCollections;
    const baseUrl = `${req.protocol}://${req.get("host")}`;

    const item = await findTimelineItemById(collections.ap_timeline, id);
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
// Creates a post via the Micropub pipeline so it goes through the full flow:
// Micropub → content file → Eleventy build → syndication → AP federation.

router.post("/api/v1/statuses", tokenRequired, scopeRequired("write", "write:statuses"), async (req, res, next) => {
  try {
    const { application, publication } = req.app.locals;
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

    // Resolve in_reply_to URL from status ID (cursor or ObjectId)
    let inReplyTo = null;
    if (inReplyToId) {
      const replyItem = await findTimelineItemById(collections.ap_timeline, inReplyToId);
      if (replyItem) {
        inReplyTo = replyItem.uid || replyItem.url;
      }
    }

    // Build JF2 properties for the Micropub pipeline.
    // Provide both text and html — linkify URLs since Micropub's markdown-it
    // doesn't have linkify enabled. Mentions are preserved as plain text;
    // the AP syndicator resolves them via WebFinger for federation delivery.
    const contentText = statusText || "";
    const contentHtml = contentText
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/(https?:\/\/[^\s<>&"')\]]+)/g, '<a href="$1">$1</a>')
      .replace(/\n/g, "<br>");

    const jf2 = {
      type: "entry",
      content: { text: contentText, html: `<p>${contentHtml}</p>` },
    };

    if (inReplyTo) {
      jf2["in-reply-to"] = inReplyTo;
    }

    if (visibility && visibility !== "public" && visibility !== "direct") {
      jf2.visibility = visibility;
    }

    // Use content-warning (not summary) to match native reader behavior
    if (spoilerText) {
      jf2["content-warning"] = spoilerText;
      jf2.sensitive = "true";
    }

    if (language) {
      jf2["mp-language"] = language;
    }


    // ── Direct messages: bypass Micropub, send via native AP DM path ──────────
    // Mastodon clients send visibility="direct" for DMs. These must NOT create
    // a public blog post — instead send a Create/Note activity directly to the
    // mentioned recipient, same as the web compose form does.
    if (visibility === "direct") {
      const federation = pluginOptions.federation;
      const handle = pluginOptions.handle || "user";
      const publicationUrl = pluginOptions.publicationUrl || baseUrl;

      if (!federation) {
        return res.status(503).json({ error: "Federation not available" });
      }

      // Extract first @user@domain mention from status text
      const mentionMatch = (statusText || "").match(/@([\w.-]+@[\w.-]+)/);
      if (!mentionMatch) {
        return res.status(422).json({ error: "Direct messages must mention a recipient (@user@domain)" });
      }
      const mentionHandle = mentionMatch[1];

      const ctx = federation.createContext(new URL(publicationUrl), {
        handle,
        publicationUrl,
      });
      const actorUri = ctx.getActorUri(handle);
      const documentLoader = await ctx.getDocumentLoader({ identifier: handle });

      // Resolve @user@domain → actor URL via WebFinger
      let recipientActorUrl;
      try {
        const webfingerUrl = `https://${mentionHandle.split("@")[1]}/.well-known/webfinger?resource=acct:${mentionHandle}`;
        const wfRes = await fetch(webfingerUrl, { headers: { Accept: "application/jrd+json" } });
        if (wfRes.ok) {
          const wf = await wfRes.json();
          recipientActorUrl = wf.links?.find((l) => l.rel === "self" && l.type?.includes("activity"))?.href;
        }
      } catch { /* fall through to lookup */ }

      // Fallback: resolve via federation lookup
      if (!recipientActorUrl) {
        try {
          const actor = await lookupWithSecurity(ctx, `acct:${mentionHandle}`, { documentLoader });
          if (actor?.id) recipientActorUrl = actor.id.href;
        } catch { /* ignore */ }
      }

      if (!recipientActorUrl) {
        return res.status(422).json({ error: `Could not resolve recipient: @${mentionHandle}` });
      }

      const uuid = crypto.randomUUID();
      const noteId = new URL(`${publicationUrl.replace(/\/$/, "")}/activitypub/notes/${uuid}`);

      const note = new Note({
        id: noteId,
        attributedTo: actorUri,
        to: new URL(recipientActorUrl),
        content: (statusText || "").trim(),
        ...(inReplyTo ? { replyTarget: new URL(inReplyTo) } : {}),
        tag: new Mention({ href: new URL(recipientActorUrl) }),
      });

      const create = new Create({
        id: new URL(`${noteId.href}#create`),
        actor: actorUri,
        to: new URL(recipientActorUrl),
        object: note,
      });

      let recipient;
      try {
        recipient = await lookupWithSecurity(ctx, new URL(recipientActorUrl), { documentLoader });
      } catch { /* ignore */ }
      if (!recipient) {
        recipient = {
          id: new URL(recipientActorUrl),
          inboxId: new URL(`${recipientActorUrl}/inbox`),
        };
      }

      await ctx.sendActivity({ identifier: handle }, recipient, create, {
        orderingKey: noteId.href,
      });
      console.info(`[Mastodon API] Sent DM to ${recipientActorUrl}`);

      const now = new Date().toISOString();
      const hostname = new URL(publicationUrl).hostname;
      const profile = await collections.ap_profile.findOne({});

      // Store in ap_notifications for the DM thread view
      try {
        const ap_notifications = collections.ap_notifications;
        if (ap_notifications) {
          await addNotification({ ap_notifications }, {
            uid: noteId.href,
            url: noteId.href,
            type: "mention",
            isDirect: true,
            direction: "outbound",
            senderActorUrl: recipientActorUrl,
            actorUrl: actorUri.href,
            actorName: profile?.name || handle,
            actorPhoto: profile?.icon || "",
            actorHandle: `@${handle}@${hostname}`,
            inReplyTo: inReplyTo || null,
            content: { text: (statusText || "").trim(), html: (statusText || "").trim() },
            published: now,
            createdAt: now,
          });
        }
      } catch (storeError) {
        console.warn("[Mastodon API] Failed to store outbound DM in notifications:", storeError.message);
      }

      // Store in ap_timeline with visibility=direct so serializeStatus can
      // produce a full Mastodon status object. Home/public timelines already
      // exclude direct-visibility items (visibility: { $nin: ["direct"] }).
      const timelineItem = {
        uid: noteId.href,
        url: noteId.href,
        type: "note",
        visibility: "direct",
        content: {
          text: (statusText || "").trim(),
          html: (statusText || "").trim(),
        },
        author: {
          name: profile?.name || handle,
          url: actorUri.href,
          photo: profile?.icon || "",
          handle: `@${handle}@${hostname}`,
        },
        published: now,
        createdAt: now,
        inReplyTo: inReplyTo || null,
        category: [],
        counts: { likes: 0, boosts: 0, replies: 0 },
      };

      try {
        await addTimelineItem(collections, timelineItem);
      } catch (storeError) {
        console.warn("[Mastodon API] Failed to store outbound DM in timeline:", storeError.message);
      }

      // Return a full serialized status so clients (Phanpy, Elk) can render it
      const status = serializeStatus(timelineItem, {
        baseUrl,
        favouritedIds: new Set(),
        rebloggedIds: new Set(),
        bookmarkedIds: new Set(),
        pinnedIds: new Set(),
      });
      return res.json(status);
    }
    // ── End DM path ───────────────────────────────────────────────────────────

    // Syndicate to AP only — posts from Mastodon clients belong to the fediverse.
    // Never cross-post to Bluesky (conversations stay in their protocol).
    // The publication URL is the AP syndicator's uid.

    const publicationUrl = pluginOptions.publicationUrl || baseUrl;
    jf2["mp-syndicate-to"] = [publicationUrl.replace(/\/$/, "") + "/"];

    // Create post via Micropub pipeline (same internal functions)
    const { postData } = await import("@indiekit/endpoint-micropub/lib/post-data.js");
    const { postContent } = await import("@indiekit/endpoint-micropub/lib/post-content.js");

    const data = await postData.create(application, publication, jf2);
    await postContent.create(publication, data);

    const postUrl = data.properties.url;
    console.info(`[Mastodon API] Created post via Micropub: ${postUrl}`);

    // Return a minimal status to the Mastodon client.
    // No timeline entry is created here — the post will appear in the timeline
    // after the normal flow: Eleventy rebuild → syndication webhook → AP delivery.
    const profile = await collections.ap_profile.findOne({});
    const handle = pluginOptions.handle || "user";

    res.json({
      id: String(Date.now()),
      created_at: new Date().toISOString(),
      content: `<p>${contentHtml}</p>`,
      url: postUrl,
      uri: postUrl,
      visibility: visibility || "public",
      sensitive: sensitive === true || sensitive === "true",
      spoiler_text: spoilerText || "",
      in_reply_to_id: inReplyToId || null,
      in_reply_to_account_id: null,
      language: language || null,
      replies_count: 0,
      reblogs_count: 0,
      favourites_count: 0,
      favourited: false,
      reblogged: false,
      bookmarked: false,
      account: {
        id: "owner",
        username: handle,
        acct: handle,
        display_name: profile?.name || handle,
        url: profile?.url || publicationUrl,
        avatar: profile?.icon || "",
        avatar_static: profile?.icon || "",
        header: "",
        header_static: "",
        followers_count: 0,
        following_count: 0,
        statuses_count: 0,
        emojis: [],
        fields: [],
      },
      media_attachments: [],
      mentions: extractMentions(contentText).map(m => ({
        id: "0",
        username: m.name.split("@")[1] || m.name,
        acct: m.name.replace(/^@/, ""),
        url: m.url,
      })),
      tags: [],
      emojis: [],
    });
  } catch (error) {
    next(error);
  }
});

// ─── DELETE /api/v1/statuses/:id ────────────────────────────────────────────
// Deletes via Micropub pipeline (removes content file + MongoDB post) and
// cleans up the ap_timeline entry.

router.delete("/api/v1/statuses/:id", tokenRequired, scopeRequired("write", "write:statuses"), async (req, res, next) => {
  try {
    const { application, publication } = req.app.locals;
    const { id } = req.params;
    const collections = req.app.locals.mastodonCollections;
    const baseUrl = `${req.protocol}://${req.get("host")}`;

    const item = await findTimelineItemById(collections.ap_timeline, id);
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

    // Delete via Micropub pipeline (removes content file from store + MongoDB posts)
    const postUrl = item.uid || item.url;
    try {
      const { postData } = await import("@indiekit/endpoint-micropub/lib/post-data.js");
      const { postContent } = await import("@indiekit/endpoint-micropub/lib/post-content.js");

      const existingPost = await postData.read(application, postUrl);
      if (existingPost) {
        const deletedData = await postData.delete(application, postUrl);
        await postContent.delete(publication, deletedData);
        console.info(`[Mastodon API] Deleted post via Micropub: ${postUrl}`);
      }
    } catch (err) {
      // Log but don't block — the post may not exist in Micropub (e.g. old pre-pipeline posts)
      console.warn(`[Mastodon API] Micropub delete failed for ${postUrl}: ${err.message}`);
    }

    // Delete from timeline
    await collections.ap_timeline.deleteOne({ _id: objectId });

    // Clean up interactions
    if (collections.ap_interactions && item.uid) {
      await collections.ap_interactions.deleteMany({ objectUrl: item.uid });
    }

    res.json(serialized);
  } catch (error) {
    next(error);
  }
});

// ─── PUT /api/v1/statuses/:id ───────────────────────────────────────────────
// Edit a post: update content via Micropub pipeline, patch ap_timeline,
// and broadcast an AP Update(Note) to followers.

router.put("/api/v1/statuses/:id", async (req, res, next) => {
  try {
    const token = req.mastodonToken;
    if (!token) {
      return res.status(401).json({ error: "The access token is invalid" });
    }

    const { application, publication } = req.app.locals;
    const collections = req.app.locals.mastodonCollections;
    const pluginOptions = req.app.locals.mastodonPluginOptions || {};
    const baseUrl = `${req.protocol}://${req.get("host")}`;

    const {
      status: statusText,
      spoiler_text: spoilerText,
      sensitive,
      language,
    } = req.body;

    if (statusText === undefined) {
      return res.status(422).json({ error: "Validation failed: Text content is required" });
    }

    const item = await findTimelineItemById(collections.ap_timeline, req.params.id);
    if (!item) {
      return res.status(404).json({ error: "Record not found" });
    }

    // Verify ownership — only allow editing own posts
    const profile = await collections.ap_profile.findOne({});
    if (profile && item.author?.url !== profile.url) {
      return res.status(403).json({ error: "This action is not allowed" });
    }

    const postUrl = item.uid || item.url;
    const now = new Date().toISOString();

    // Update via Micropub pipeline (updates MongoDB posts + content file)
    let updatedContent = processStatusContent({ text: statusText, html: "" }, statusText);
    try {
      const { postData } = await import("@indiekit/endpoint-micropub/lib/post-data.js");
      const { postContent } = await import("@indiekit/endpoint-micropub/lib/post-content.js");

      const operation = { replace: { content: [statusText] } };
      if (spoilerText !== undefined) operation.replace.summary = [spoilerText];
      if (sensitive !== undefined) operation.replace.sensitive = [String(sensitive)];
      if (language !== undefined) operation.replace["mp-language"] = [language];

      const updatedPost = await postData.update(application, publication, postUrl, operation);
      if (updatedPost) {
        await postContent.update(publication, updatedPost, postUrl);
        const rawContent = updatedPost.properties?.content;
        if (rawContent) {
          updatedContent = processStatusContent(
            typeof rawContent === "string" ? { text: rawContent, html: "" } : rawContent,
            statusText,
          );
        }
      }
    } catch (err) {
      console.warn(`[Mastodon API] Micropub update failed for ${postUrl}: ${err.message}`);
    }

    // Patch the ap_timeline document
    const newSummary = spoilerText !== undefined ? spoilerText : (item.summary || "");
    const newSensitive = sensitive !== undefined
      ? (sensitive === true || sensitive === "true")
      : (item.sensitive || false);
    await collections.ap_timeline.updateOne(
      { _id: item._id },
      { $set: { content: updatedContent, summary: newSummary, sensitive: newSensitive, updatedAt: now } },
    );
    const updatedItem = { ...item, content: updatedContent, summary: newSummary, sensitive: newSensitive, updatedAt: now };

    // Broadcast AP Update(Note) to followers (best-effort)
    try {
      const federation = pluginOptions.federation;
      const handle = pluginOptions.handle || "user";
      const publicationUrl = pluginOptions.publicationUrl || baseUrl;
      if (federation) {
        const ctx = federation.createContext(new URL(publicationUrl), { handle, publicationUrl });
        const actorUri = ctx.getActorUri(handle);
        const publicAddress = new URL("https://www.w3.org/ns/activitystreams#Public");
        const followersUri = ctx.getFollowersUri(handle);
        const note = new Note({
          id: new URL(postUrl),
          attributedTo: actorUri,
          content: updatedContent.html || updatedContent.text || statusText,
          summary: newSummary || null,
          sensitive: newSensitive,
          published: item.published ? new Date(item.published) : null,
          updated: new Date(now),
          to: publicAddress,
          cc: followersUri,
        });
        const updateActivity = new Update({
          actor: actorUri,
          object: note,
          to: publicAddress,
          cc: followersUri,
        });
        await ctx.sendActivity({ identifier: handle }, "followers", updateActivity, {
          preferSharedInbox: true,
          orderingKey: postUrl,
        });
        console.info(`[Mastodon API] Sent Update(Note) for ${postUrl}`);
      }
    } catch (err) {
      console.warn(`[Mastodon API] AP Update broadcast failed for ${postUrl}: ${err.message}`);
    }

    const interactionState = await loadItemInteractions(collections, updatedItem);
    res.json(serializeStatus(updatedItem, { baseUrl, ...interactionState }));
  } catch (error) {
    next(error);
  }
});

// ─── GET /api/v1/statuses/:id/favourited_by ─────────────────────────────────

router.get("/api/v1/statuses/:id/favourited_by", tokenRequired, scopeRequired("read", "read:statuses"), async (req, res) => {
  // Stub — we don't track who favourited remotely
  res.json([]);
});

// ─── GET /api/v1/statuses/:id/reblogged_by ──────────────────────────────────

router.get("/api/v1/statuses/:id/reblogged_by", tokenRequired, scopeRequired("read", "read:statuses"), async (req, res) => {
  // Stub — we don't track who boosted remotely
  res.json([]);
});

// ─── POST /api/v1/statuses/:id/favourite ────────────────────────────────────

router.post("/api/v1/statuses/:id/favourite", tokenRequired, scopeRequired("write", "write:favourites"), async (req, res, next) => {
  try {
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

    res.json(serializeStatus(item, { baseUrl, ...interactionState }));
  } catch (error) {
    next(error);
  }
});

// ─── POST /api/v1/statuses/:id/unfavourite ──────────────────────────────────

router.post("/api/v1/statuses/:id/unfavourite", tokenRequired, scopeRequired("write", "write:favourites"), async (req, res, next) => {
  try {
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

    res.json(serializeStatus(item, { baseUrl, ...interactionState }));
  } catch (error) {
    next(error);
  }
});

// ─── POST /api/v1/statuses/:id/reblog ───────────────────────────────────────

router.post("/api/v1/statuses/:id/reblog", tokenRequired, scopeRequired("write", "write:statuses"), async (req, res, next) => {
  try {
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

    res.json(serializeStatus(item, { baseUrl, ...interactionState }));
  } catch (error) {
    next(error);
  }
});

// ─── POST /api/v1/statuses/:id/unreblog ─────────────────────────────────────

router.post("/api/v1/statuses/:id/unreblog", tokenRequired, scopeRequired("write", "write:statuses"), async (req, res, next) => {
  try {
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

    res.json(serializeStatus(item, { baseUrl, ...interactionState }));
  } catch (error) {
    next(error);
  }
});

// ─── POST /api/v1/statuses/:id/bookmark ─────────────────────────────────────

router.post("/api/v1/statuses/:id/bookmark", tokenRequired, scopeRequired("write", "write:bookmarks"), async (req, res, next) => {
  try {
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

    res.json(serializeStatus(item, { baseUrl, ...interactionState }));
  } catch (error) {
    next(error);
  }
});

// ─── POST /api/v1/statuses/:id/unbookmark ───────────────────────────────────

router.post("/api/v1/statuses/:id/unbookmark", tokenRequired, scopeRequired("write", "write:bookmarks"), async (req, res, next) => {
  try {
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

    res.json(serializeStatus(item, { baseUrl, ...interactionState }));
  } catch (error) {
    next(error);
  }
});

// ─── POST /api/v1/statuses/:id/pin ──────────────────────────────────────────

router.post("/api/v1/statuses/:id/pin", async (req, res, next) => {
  try {
    const token = req.mastodonToken;
    if (!token) {
      return res.status(401).json({ error: "The access token is invalid" });
    }

    const { item, collections, baseUrl } = await resolveStatusForInteraction(req);
    if (!item) {
      return res.status(404).json({ error: "Record not found" });
    }

    const postUrl = item.uid || item.url;
    if (collections.ap_featured) {
      const count = await collections.ap_featured.countDocuments();
      if (count >= 5) {
        return res.status(422).json({ error: "Maximum number of pinned posts reached" });
      }
      await collections.ap_featured.updateOne(
        { postUrl },
        { $set: { postUrl, pinnedAt: new Date().toISOString() } },
        { upsert: true },
      );
    }

    const pluginOptions = req.app.locals.mastodonPluginOptions || {};
    if (pluginOptions.broadcastActorUpdate) {
      pluginOptions.broadcastActorUpdate().catch(() => {});
    }

    const interactionState = await loadItemInteractions(collections, item);
    interactionState.pinnedIds.add(item.uid);

    res.json(serializeStatus(item, { baseUrl, ...interactionState }));
  } catch (error) {
    next(error);
  }
});

// ─── POST /api/v1/statuses/:id/unpin ────────────────────────────────────────

router.post("/api/v1/statuses/:id/unpin", async (req, res, next) => {
  try {
    const token = req.mastodonToken;
    if (!token) {
      return res.status(401).json({ error: "The access token is invalid" });
    }

    const { item, collections, baseUrl } = await resolveStatusForInteraction(req);
    if (!item) {
      return res.status(404).json({ error: "Record not found" });
    }

    const postUrl = item.uid || item.url;
    if (collections.ap_featured) {
      await collections.ap_featured.deleteOne({ postUrl });
    }

    const pluginOptions = req.app.locals.mastodonPluginOptions || {};
    if (pluginOptions.broadcastActorUpdate) {
      pluginOptions.broadcastActorUpdate().catch(() => {});
    }

    const interactionState = await loadItemInteractions(collections, item);
    interactionState.pinnedIds.delete(item.uid);

    res.json(serializeStatus(item, { baseUrl, ...interactionState }));
  } catch (error) {
    next(error);
  }
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Find a timeline item by cursor ID (published-based) or ObjectId (legacy).
 * Status IDs are now encodeCursor(published) — milliseconds since epoch.
 * Falls back to ObjectId lookup for backwards compatibility.
 *
 * @param {object} collection - ap_timeline collection
 * @param {string} id - Status ID from client
 * @returns {Promise<object|null>} Timeline document or null
 */
async function findTimelineItemById(collection, id) {
  // Try cursor-based lookup first (published date from ms-since-epoch)
  const publishedDate = decodeCursor(id);
  if (publishedDate) {
    // Try exact UTC ISO match (e.g., "2026-03-21T15:33:50.000Z")
    let item = await collection.findOne({ published: publishedDate });
    if (item) return item;

    // Try without milliseconds — stored dates often lack .000Z
    // e.g., "2026-03-21T15:33:50Z" vs "2026-03-21T15:33:50.000Z"
    const withoutMs = publishedDate.replace(/\.000Z$/, "Z");
    if (withoutMs !== publishedDate) {
      item = await collection.findOne({ published: withoutMs });
      if (item) return item;
    }

    // Try BSON Date (Micropub pipeline stores published as Date objects)
    item = await collection.findOne({ published: new Date(publishedDate) });
    if (item) return item;

    // Try ±1 s range lookup for timezone-offset stored strings (+01:00 etc.)
    // and BSON Date fields. The UTC-ISO string range query used above fails when
    // the stored value has a non-UTC timezone — "2026-03-21T16:33:50+01:00" is
    // lexicographically outside ["2026-03-21T15:33:50Z", "2026-03-21T15:33:51Z"].
    // $dateFromString parses any ISO 8601 format (including offsets) to a Date,
    // $toLong converts it to ms-since-epoch, and the numeric range always matches.
    const ms = Number.parseInt(id, 10);
    if (ms > 0) {
      const lo = new Date(ms - 999);
      const hi = new Date(ms + 999);
      item = await collection.findOne({
        $or: [
          // BSON Date stored (Micropub pipeline) — direct Date range comparison
          { published: { $gte: lo, $lte: hi } },
          // String stored with any timezone format — parse via $dateFromString
          {
            $expr: {
              $and: [
                { $gte: [
                  { $toLong: { $dateFromString: { dateString: "$published", onError: 0, onNull: 0 } } },
                  ms - 999,
                ] },
                { $lte: [
                  { $toLong: { $dateFromString: { dateString: "$published", onError: 0, onNull: 0 } } },
                  ms + 999,
                ] },
              ],
            },
          },
        ],
      });
      if (item) return item;
    }
  }

  // Fall back to ObjectId lookup (legacy IDs)
  try {
    return await collection.findOne({ _id: new ObjectId(id) });
  } catch {
    return null;
  }
}

/**
 * Resolve a timeline item from the :id param, plus common context.
 */
async function resolveStatusForInteraction(req) {
  const collections = req.app.locals.mastodonCollections;
  const baseUrl = `${req.protocol}://${req.get("host")}`;

  const item = await findTimelineItemById(collections.ap_timeline, req.params.id);
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
    loadRsaKey: pluginOptions.loadRsaKey,
  };
}

async function loadItemInteractions(collections, item) {
  const favouritedIds = new Set();
  const rebloggedIds = new Set();
  const bookmarkedIds = new Set();
  const pinnedIds = new Set();

  if (!item.uid) {
    return { favouritedIds, rebloggedIds, bookmarkedIds, pinnedIds };
  }

  const lookupUrls = [item.uid, item.url].filter(Boolean);

  if (collections.ap_interactions) {
    const interactions = await collections.ap_interactions
      .find({ objectUrl: { $in: lookupUrls } })
      .toArray();

    for (const i of interactions) {
      const uid = item.uid;
      if (i.type === "like") favouritedIds.add(uid);
      else if (i.type === "boost") rebloggedIds.add(uid);
      else if (i.type === "bookmark") bookmarkedIds.add(uid);
    }
  }

  if (collections.ap_featured) {
    const pinDoc = await collections.ap_featured.findOne({
      postUrl: { $in: lookupUrls },
    });
    if (pinDoc) pinnedIds.add(item.uid);
  }

  return { favouritedIds, rebloggedIds, bookmarkedIds, pinnedIds };
}

/**

 * Process status content: linkify bare URLs and convert @mentions to links.
 *
 * Mastodon clients send plain text — the server is responsible for
 * converting URLs and mentions into HTML links.
 *
 * @param {object} content - { text, html } from Micropub pipeline
 * @param {string} rawText - Original status text from client
 * @returns {object} { text, html } with linkified content
 */
function processStatusContent(content, rawText) {
  let html = content.html || content.text || rawText || "";

  // If the HTML is just plain text wrapped in <p>, process it
  // Don't touch HTML that already has links (from Micropub rendering)
  if (!html.includes("<a ")) {
    // Linkify bare URLs (http/https)
    html = html.replace(
      /(https?:\/\/[^\s<>"')\]]+)/g,
      (_, url) => {
        // Strip trailing punctuation that is almost never part of a URL
        const clean = url.replace(/[.,;:!?]+$/, "");
        return `<a href="${clean}" rel="nofollow noopener noreferrer" target="_blank">${clean}</a>`;
      },
    );

    // Convert @user@domain mentions to profile links
    html = html.replace(
      /(?:^|\s)(@([a-zA-Z0-9_]+)@([a-zA-Z0-9.-]+\.[a-zA-Z]{2,}))/g,
      (match, full, username, domain) =>
        match.replace(
          full,
          `<span class="h-card"><a href="https://${domain}/@${username}" class="u-url mention" rel="nofollow noopener noreferrer" target="_blank">@${username}@${domain}</a></span>`,
        ),
    );
  }

  return {
    text: content.text || rawText || "",
    html,
  };
}

/**

 * Extract @user@domain mentions from text into mention objects.
 *
 * @param {string} text - Status text
 * @returns {Array<{name: string, url: string}>} Mention objects
 */
function extractMentions(text) {
  if (!text) return [];
  const mentionRegex = /@([a-zA-Z0-9_]+)@([a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g;
  const mentions = [];
  const seen = new Set();
  let match;
  while ((match = mentionRegex.exec(text)) !== null) {
    const [, username, domain] = match;
    const key = `${username}@${domain}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    mentions.push({
      name: `@${username}@${domain}`,
      url: `https://${domain}/@${username}`,
    });
  }
  return mentions;
}

export default router;
