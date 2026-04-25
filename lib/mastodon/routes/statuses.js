/**
 * Status endpoints for Mastodon Client API.
 *
 * GET /api/v1/statuses/:id — single status
 * GET /api/v1/statuses/:id/context — thread context (ancestors + descendants)
 * POST /api/v1/statuses — create post via Micropub pipeline
 * PUT /api/v1/statuses/:id — edit an existing post
 * DELETE /api/v1/statuses/:id — delete post via Micropub pipeline
 * GET /api/v1/statuses/:id/history — edit history
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
import { Note, Create, Mention } from "@fedify/fedify/vocab";
import { ObjectId } from "mongodb";
import { serializeStatus } from "../entities/status.js";
import { resolveReplyIds } from "../helpers/resolve-reply-ids.js";
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
    const { replyIdMap, replyAccountIdMap } = await resolveReplyIds(collections.ap_timeline, [item]);

    const status = serializeStatus(item, {
      baseUrl,
      ...interactionState,
      pinnedIds: new Set(),
      replyIdMap,
      replyAccountIdMap,
    });

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
    const allItems = [...ancestors, ...descendants];
    const { replyIdMap, replyAccountIdMap } = await resolveReplyIds(collections.ap_timeline, allItems);

    // Load real interaction state for thread context
    const ctxFavouritedIds = new Set();
    const ctxRebloggedIds = new Set();
    const ctxBookmarkedIds = new Set();
    if (allItems.length > 0 && collections.ap_interactions) {
      const ctxUrlToUid = new Map();
      for (const ci of allItems) {
        if (ci.uid) { ctxUrlToUid.set(ci.uid, ci.uid); }
        if (ci.url && ci.url !== ci.uid) { ctxUrlToUid.set(ci.url, ci.uid || ci.url); }
      }
      const ctxLookupUrls = [...ctxUrlToUid.keys()];
      if (ctxLookupUrls.length > 0) {
        const ctxInteractions = await collections.ap_interactions
          .find({ objectUrl: { $in: ctxLookupUrls } })
          .toArray();
        for (const ci of ctxInteractions) {
          const uid = ctxUrlToUid.get(ci.objectUrl) || ci.objectUrl;
          if (ci.type === "like") ctxFavouritedIds.add(uid);
          else if (ci.type === "boost") ctxRebloggedIds.add(uid);
          else if (ci.type === "bookmark") ctxBookmarkedIds.add(uid);
        }
      }
    }
    const serializeOpts = { baseUrl, favouritedIds: ctxFavouritedIds, rebloggedIds: ctxRebloggedIds, bookmarkedIds: ctxBookmarkedIds, pinnedIds: new Set(), replyIdMap, replyAccountIdMap };

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

    // Idempotency-Key support — prevent duplicate posts on client retry
    const idempotencyKey = req.headers["idempotency-key"];
    if (idempotencyKey && collections.ap_idempotency) {
      const { createHash } = await import("node:crypto");
      const key = createHash("sha256")
        .update(`${baseUrl}:${idempotencyKey}`)
        .digest("hex");
      const cached = await collections.ap_idempotency.findOne({ key });
      if (cached) {
        return res.json(cached.response);
      }
    }

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

    // Resolve media_ids to URLs from ap_media collection
    const mediaUrls = [];
    if (mediaIds && mediaIds.length > 0 && collections.ap_media) {
      const { ObjectId: MediaObjectId } = await import("mongodb");
      for (const mediaId of Array.isArray(mediaIds) ? mediaIds : [mediaIds]) {
        try {
          const media = await collections.ap_media.findOne({
            _id: new MediaObjectId(mediaId),
          });
          if (media) {
            mediaUrls.push({
              url: media.url,
              alt: media.description || "",
              type: media.mimeType,
            });
          }
        } catch {
          /* invalid ObjectId, skip */
        }
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

    // Add media from media_ids
    for (const m of mediaUrls) {
      if (m.type?.startsWith("image/")) {
        if (!jf2.photo) jf2.photo = [];
        jf2.photo.push({ url: m.url, alt: m.alt });
      } else if (m.type?.startsWith("video/")) {
        if (!jf2.video) jf2.video = [];
        jf2.video.push(m.url);
      } else if (m.type?.startsWith("audio/")) {
        if (!jf2.audio) jf2.audio = [];
        jf2.audio.push(m.url);
      }
    }

    // Create post via Micropub pipeline (same internal functions)
    const { postData } = await import("@indiekit/endpoint-micropub/lib/post-data.js");
    const { postContent } = await import("@indiekit/endpoint-micropub/lib/post-content.js");

    const data = await postData.create(application, publication, jf2);
    await postContent.create(publication, data);

    const postUrl = data.properties.url;
    console.info(`[Mastodon API] Created post via Micropub: ${postUrl}`);

    // Return a minimal status to the Mastodon client.
    // Eagerly insert own post into ap_timeline so the Mastodon client can resolve
    // in_reply_to_id for this post immediately, without waiting for the build webhook.
    // The AP syndicator will upsert the same uid later via $setOnInsert (no-op).
    const profile = await collections.ap_profile.findOne({});
    const handle = pluginOptions.handle || "user";
    let _tlItem = null;
    try {
      const _ph = (() => { try { return new URL(publicationUrl).hostname; } catch { return ""; } })();
      _tlItem = await addTimelineItem(collections, {
        uid: postUrl,
        url: postUrl,
        type: data.properties["post-type"] || "note",
        content: { text: contentText, html: `<p>${contentHtml}</p>` },
        author: {
          name: profile?.name || handle,
          url: profile?.url || publicationUrl,
          photo: profile?.icon || "",
          handle: `@${handle}@${_ph}`,
          emojis: [],
          bot: false,
        },
        published: data.properties.published || new Date().toISOString(),
        createdAt: new Date().toISOString(),
        inReplyTo: inReplyTo || null,
        inReplyToId: inReplyToId || null,
        visibility: jf2.visibility || "public",
        sensitive: jf2.sensitive === "true",
        category: [],
        counts: { likes: 0, boosts: 0, replies: 0 },
      });
    } catch (tlErr) {
      console.warn(`[Mastodon API] Failed to pre-insert own post into timeline: ${tlErr.message}`);
    }

    const statusResponse = {
      id: _tlItem?._id?.toString() || String(Date.now()),
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
    };

    // Cache response for idempotency
    if (idempotencyKey && collections.ap_idempotency) {
      const { createHash } = await import("node:crypto");
      const key = createHash("sha256")
        .update(`${baseUrl}:${idempotencyKey}`)
        .digest("hex");
      await collections.ap_idempotency
        .insertOne({ key, response: statusResponse, createdAt: new Date() })
        .catch(() => {});
    }

    res.json(statusResponse);
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
    await collections.ap_timeline.deleteOne({ _id: item._id });

    // Broadcast AP Delete activity to followers
    const _pluginOpts = req.app.locals.mastodonPluginOptions || {};
    if (_pluginOpts.broadcastDelete && postUrl) {
      _pluginOpts.broadcastDelete(postUrl).catch((err) =>
        console.warn(`[Mastodon API] broadcastDelete failed for ${postUrl}: ${err.message}`),
      );
    }

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
// Edit an existing status. Stores the previous version for history.

router.put("/api/v1/statuses/:id", tokenRequired, scopeRequired("write", "write:statuses"), async (req, res, next) => {
  try {
    const { application, publication } = req.app.locals;
    const collections = req.app.locals.mastodonCollections;
    const pluginOptions = req.app.locals.mastodonPluginOptions || {};
    const baseUrl = `${req.protocol}://${req.get("host")}`;
    const localPublicationUrl = publication?.me || pluginOptions.publicationUrl || application?.url;

    const item = await findTimelineItemById(collections.ap_timeline, req.params.id);
    if (!item) {
      return res.status(404).json({ error: "Record not found" });
    }

    // Verify ownership — only the local author can edit
    if (!item.author?.url || item.author.url !== localPublicationUrl) {
      return res.status(403).json({ error: "This action is not allowed" });
    }

    const {
      status: statusText,
      spoiler_text: spoilerText,
      sensitive,
      language,
    } = req.body;


    // Store current version in edit history
    if (collections.ap_status_edits) {
      await collections.ap_status_edits.insertOne({
        statusId: req.params.id,
        content: item.content || {},
        summary: item.summary || "",
        sensitive: item.sensitive || false,
        media: [
          ...(item.photo || []),
          ...(item.video || []),
          ...(item.audio || []),
        ],
        editedAt: new Date().toISOString(),
      });
    }

    // Send update via Micropub
    const postUrl = item.uid || item.url;
    if (postUrl && application.micropubEndpoint) {
      const micropubUrl = application.micropubEndpoint.startsWith("http")
        ? application.micropubEndpoint
        : new URL(application.micropubEndpoint, application.url).href;

      const token =
        req.session?.access_token ||
        req.mastodonToken?.indieauthToken ||
        req.mastodonToken?.accessToken;
      if (token) {
        const updatePayload = {
          action: "update",
          url: postUrl,
          replace: {},
        };

        if (statusText !== undefined) {
          updatePayload.replace.content = [statusText];
        }
        if (spoilerText !== undefined) {
          updatePayload.replace["content-warning"] = spoilerText ? [spoilerText] : [];
          updatePayload.replace.sensitive = [spoilerText ? "true" : "false"];
        }
        if (sensitive !== undefined && spoilerText === undefined) {
          updatePayload.replace.sensitive = [sensitive === true || sensitive === "true" ? "true" : "false"];
        }

        try {
          await fetch(micropubUrl, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
              Accept: "application/json",
            },
            body: JSON.stringify(updatePayload),
          });
        } catch (err) {
          console.warn(
            `[Mastodon API] Micropub update failed: ${err.message}`,
          );
        }
      }
    }

    // Update timeline item directly
    const updateFields = {};
    if (statusText !== undefined) {
      const contentHtml = statusText
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(
          /(https?:\/\/[^\s<>&"')\]]+)/g,
          '<a href="$1">$1</a>',
        )
        .replace(/\n/g, "<br>");
      updateFields["content.text"] = statusText;
      updateFields["content.html"] = contentHtml;
    }
    if (spoilerText !== undefined) updateFields.summary = spoilerText;
    if (sensitive !== undefined)
      updateFields.sensitive = sensitive === "true" || sensitive === true;
    if (language !== undefined) updateFields.language = language;
    updateFields.updatedAt = new Date().toISOString();

    await collections.ap_timeline.updateOne(
      { _id: item._id },
      { $set: updateFields },
    );

    // Reload and serialize
    const updated = await collections.ap_timeline.findOne({
      _id: item._id,
    });
    const interactionState = await loadItemInteractions(collections, updated);
    const { replyIdMap, replyAccountIdMap } = await resolveReplyIds(collections.ap_timeline, [updated]);

    const serialized = serializeStatus(updated, {
      baseUrl,
      ...interactionState,
      pinnedIds: new Set(),
      replyIdMap,
      replyAccountIdMap,
    });
    res.json(serialized);
  } catch (error) {
    next(error);
  }
});

// ─── GET /api/v1/statuses/:id/history ───────────────────────────────────────

router.get("/api/v1/statuses/:id/history", tokenRequired, scopeRequired("read", "read:statuses"), async (req, res, next) => {
  try {
    const collections = req.app.locals.mastodonCollections;
    const pluginOptions = req.app.locals.mastodonPluginOptions || {};
    const baseUrl = `${req.protocol}://${req.get("host")}`;

    const item = await findTimelineItemById(collections.ap_timeline, req.params.id);
    if (!item) {
      return res.status(404).json({ error: "Record not found" });
    }

    const edits = collections.ap_status_edits
      ? await collections.ap_status_edits
          .find({ statusId: req.params.id })
          .sort({ editedAt: 1 })
          .toArray()
      : [];

    const { serializeAccount } = await import("../entities/account.js");
    const localPublicationUrl = pluginOptions.publicationUrl || baseUrl;
    const handle = pluginOptions.actor?.handle || "";

    const accountObj = item.author
      ? serializeAccount(item.author, {
          baseUrl,
          isLocal: item.author.url === localPublicationUrl,
          handle,
        })
      : null;

    // Build history: each edit snapshot + current version as latest
    const history = edits.map((edit) => ({
      content: edit.content?.html || edit.content?.text || "",
      spoiler_text: edit.summary || "",
      sensitive: edit.sensitive || false,
      created_at: edit.editedAt,
      account: accountObj,
      media_attachments: [],
      emojis: [],
    }));

    // Add current version as the latest entry
    history.push({
      content: item.content?.html || item.content?.text || "",
      spoiler_text: item.summary || "",
      sensitive: item.sensitive || false,
      created_at: item.updatedAt || item.published || item.createdAt,
      account: accountObj,
      media_attachments: [],
      emojis: [],
    });

    res.json(history);
  } catch (error) {
    next(error);
  }
});

// ─── GET /api/v1/statuses/:id/favourited_by ─────────────────────────────────

router.get("/api/v1/statuses/:id/favourited_by", tokenRequired, scopeRequired("read", "read:statuses"), async (req, res, next) => {
  try {
    const collections = req.app.locals.mastodonCollections;
    const baseUrl = `${req.protocol}://${req.get("host")}`;

    const item = await findTimelineItemById(
      collections.ap_timeline,
      req.params.id,
    );
    if (!item) return res.status(404).json({ error: "Record not found" });

    const targetUrl = item.uid || item.url;
    if (!targetUrl || !collections.ap_notifications) return res.json([]);

    // Incoming likes are stored as notifications by the inbox handler
    const notifications = await collections.ap_notifications
      .find({ targetUrl, type: "like" })
      .limit(40)
      .toArray();

    const { serializeAccount } = await import("../entities/account.js");
    const accounts = notifications
      .filter((n) => n.actorUrl)
      .map((n) =>
        serializeAccount(
          {
            url: n.actorUrl,
            name: n.actorName || "",
            handle: n.actorHandle || "",
            photo: n.actorPhoto || "",
          },
          { baseUrl, isLocal: false },
        ),
      );

    res.json(accounts);
  } catch (error) {
    next(error);
  }
});

// ─── GET /api/v1/statuses/:id/reblogged_by ──────────────────────────────────

router.get("/api/v1/statuses/:id/reblogged_by", tokenRequired, scopeRequired("read", "read:statuses"), async (req, res, next) => {
  try {
    const collections = req.app.locals.mastodonCollections;
    const baseUrl = `${req.protocol}://${req.get("host")}`;

    const item = await findTimelineItemById(
      collections.ap_timeline,
      req.params.id,
    );
    if (!item) return res.status(404).json({ error: "Record not found" });

    const targetUrl = item.uid || item.url;
    if (!targetUrl || !collections.ap_notifications) return res.json([]);

    // Incoming boosts are stored as notifications by the inbox handler
    const notifications = await collections.ap_notifications
      .find({ targetUrl, type: "boost" })
      .limit(40)
      .toArray();

    const { serializeAccount } = await import("../entities/account.js");
    const accounts = notifications
      .filter((n) => n.actorUrl)
      .map((n) =>
        serializeAccount(
          {
            url: n.actorUrl,
            name: n.actorName || "",
            handle: n.actorHandle || "",
            photo: n.actorPhoto || "",
          },
          { baseUrl, isLocal: false },
        ),
      );

    res.json(accounts);
  } catch (error) {
    next(error);
  }
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

// ─── GET /api/v1/statuses/:id/card ──────────────────────────────────────────

router.get("/api/v1/statuses/:id/card", async (req, res, next) => {
  try {
    const collections = req.app.locals.mastodonCollections;
    const item = await findTimelineItemById(
      collections.ap_timeline,
      req.params.id,
    );
    if (!item) {
      return res.status(404).json({ error: "Record not found" });
    }

    const { serializeCard } = await import("../entities/status.js");
    const card = serializeCard(item.linkPreviews?.[0]);
    if (!card) {
      return res.json({});
    }

    res.json(card);
  } catch (error) {
    next(error);
  }
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Find a timeline item by ObjectId.
 *
 * @param {object} collection - ap_timeline collection
 * @param {string} id - MongoDB ObjectId string
 * @returns {Promise<object|null>} Timeline document or null
 */
async function findTimelineItemById(collection, id) {
  try {
    const _oid = new ObjectId(id);
    const _doc = await collection.findOne({ _id: _oid });
    if (!_doc) console.warn(`[Mastodon API] findTimelineItemById: no item for id=${id}`);
    return _doc;
  } catch (_fErr) {
    console.warn(`[Mastodon API] findTimelineItemById: invalid id=${id}: ${_fErr.message}`);
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
