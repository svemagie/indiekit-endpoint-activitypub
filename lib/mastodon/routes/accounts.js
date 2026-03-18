/**
 * Account endpoints for Mastodon Client API.
 *
 * Phase 1: verify_credentials, preferences, account lookup
 * Phase 2: relationships, follow/unfollow, account statuses
 */
import express from "express";
import { serializeCredentialAccount, serializeAccount } from "../entities/account.js";
import { accountId, remoteActorId } from "../helpers/id-mapping.js";

const router = express.Router(); // eslint-disable-line new-cap

// ─── GET /api/v1/accounts/verify_credentials ─────────────────────────────────

router.get("/api/v1/accounts/verify_credentials", async (req, res, next) => {
  try {
    const token = req.mastodonToken;
    if (!token) {
      return res.status(401).json({ error: "The access token is invalid" });
    }

    const baseUrl = `${req.protocol}://${req.get("host")}`;
    const collections = req.app.locals.mastodonCollections;
    const pluginOptions = req.app.locals.mastodonPluginOptions || {};
    const handle = pluginOptions.handle || "user";

    const profile = await collections.ap_profile.findOne({});
    if (!profile) {
      return res.status(404).json({ error: "Profile not found" });
    }

    // Get counts
    let counts = {};
    try {
      const [statuses, followers, following] = await Promise.all([
        collections.ap_timeline.countDocuments({
          "author.url": profile.url,
        }),
        collections.ap_followers.countDocuments({}),
        collections.ap_following.countDocuments({}),
      ]);
      counts = { statuses, followers, following };
    } catch {
      counts = { statuses: 0, followers: 0, following: 0 };
    }

    const account = serializeCredentialAccount(profile, {
      baseUrl,
      handle,
      counts,
    });

    res.json(account);
  } catch (error) {
    next(error);
  }
});

// ─── GET /api/v1/preferences ─────────────────────────────────────────────────

router.get("/api/v1/preferences", (req, res) => {
  res.json({
    "posting:default:visibility": "public",
    "posting:default:sensitive": false,
    "posting:default:language": "en",
    "reading:expand:media": "default",
    "reading:expand:spoilers": false,
  });
});

// ─── GET /api/v1/accounts/lookup ─────────────────────────────────────────────

router.get("/api/v1/accounts/lookup", async (req, res, next) => {
  try {
    const { acct } = req.query;
    if (!acct) {
      return res.status(400).json({ error: "Missing acct parameter" });
    }

    const baseUrl = `${req.protocol}://${req.get("host")}`;
    const collections = req.app.locals.mastodonCollections;
    const pluginOptions = req.app.locals.mastodonPluginOptions || {};
    const handle = pluginOptions.handle || "user";

    // Check if looking up local account
    const bareAcct = acct.startsWith("@") ? acct.slice(1) : acct;
    const localDomain = req.get("host");

    if (
      bareAcct === handle ||
      bareAcct === `${handle}@${localDomain}`
    ) {
      const profile = await collections.ap_profile.findOne({});
      if (profile) {
        return res.json(
          serializeAccount(profile, { baseUrl, isLocal: true, handle }),
        );
      }
    }

    // Check followers/following for known remote actors
    const follower = await collections.ap_followers.findOne({
      $or: [
        { handle: `@${bareAcct}` },
        { handle: bareAcct },
      ],
    });
    if (follower) {
      return res.json(
        serializeAccount(
          { name: follower.name, url: follower.actorUrl, photo: follower.avatar, handle: follower.handle },
          { baseUrl },
        ),
      );
    }

    return res.status(404).json({ error: "Record not found" });
  } catch (error) {
    next(error);
  }
});

// ─── GET /api/v1/accounts/:id ────────────────────────────────────────────────

router.get("/api/v1/accounts/:id", async (req, res, next) => {
  try {
    const { id } = req.params;
    const baseUrl = `${req.protocol}://${req.get("host")}`;
    const collections = req.app.locals.mastodonCollections;
    const pluginOptions = req.app.locals.mastodonPluginOptions || {};
    const handle = pluginOptions.handle || "user";

    // Check if it's the local profile
    const profile = await collections.ap_profile.findOne({});
    if (profile && profile._id.toString() === id) {
      return res.json(
        serializeAccount(profile, { baseUrl, isLocal: true, handle }),
      );
    }

    // Search known actors (followers, following, timeline authors)
    // by checking if the deterministic hash matches
    const follower = await collections.ap_followers
      .find({})
      .toArray();
    for (const f of follower) {
      if (remoteActorId(f.actorUrl) === id) {
        return res.json(
          serializeAccount(
            { name: f.name, url: f.actorUrl, photo: f.avatar, handle: f.handle },
            { baseUrl },
          ),
        );
      }
    }

    const following = await collections.ap_following
      .find({})
      .toArray();
    for (const f of following) {
      if (remoteActorId(f.actorUrl) === id) {
        return res.json(
          serializeAccount(
            { name: f.name, url: f.actorUrl, photo: f.avatar, handle: f.handle },
            { baseUrl },
          ),
        );
      }
    }

    // Try timeline authors
    const timelineItem = await collections.ap_timeline.findOne({
      $expr: { $ne: [{ $type: "$author.url" }, "missing"] },
    });
    // For now, if not found in known actors, return 404
    return res.status(404).json({ error: "Record not found" });
  } catch (error) {
    next(error);
  }
});

// ─── GET /api/v1/accounts/relationships ──────────────────────────────────────

router.get("/api/v1/accounts/relationships", async (req, res, next) => {
  try {
    // id[] can come as single value or array
    let ids = req.query["id[]"] || req.query.id || [];
    if (!Array.isArray(ids)) ids = [ids];

    if (ids.length === 0) {
      return res.json([]);
    }

    const collections = req.app.locals.mastodonCollections;

    // Load all followers/following for efficient lookup
    const [followers, following, blocked, muted] = await Promise.all([
      collections.ap_followers.find({}).toArray(),
      collections.ap_following.find({}).toArray(),
      collections.ap_blocked.find({}).toArray(),
      collections.ap_muted.find({}).toArray(),
    ]);

    const followerIds = new Set(followers.map((f) => remoteActorId(f.actorUrl)));
    const followingIds = new Set(following.map((f) => remoteActorId(f.actorUrl)));
    const blockedIds = new Set(blocked.map((b) => remoteActorId(b.url)));
    const mutedIds = new Set(muted.filter((m) => m.url).map((m) => remoteActorId(m.url)));

    const relationships = ids.map((id) => ({
      id,
      following: followingIds.has(id),
      showing_reblogs: followingIds.has(id),
      notifying: false,
      languages: [],
      followed_by: followerIds.has(id),
      blocking: blockedIds.has(id),
      blocked_by: false,
      muting: mutedIds.has(id),
      muting_notifications: mutedIds.has(id),
      requested: false,
      requested_by: false,
      domain_blocking: false,
      endorsed: false,
      note: "",
    }));

    res.json(relationships);
  } catch (error) {
    next(error);
  }
});

// ─── GET /api/v1/accounts/familiar_followers ─────────────────────────────────

router.get("/api/v1/accounts/familiar_followers", (req, res) => {
  // Stub — returns empty for each requested ID
  let ids = req.query["id[]"] || req.query.id || [];
  if (!Array.isArray(ids)) ids = [ids];
  res.json(ids.map((id) => ({ id, accounts: [] })));
});

// ─── POST /api/v1/accounts/:id/follow ───────────────────────────────────────

router.post("/api/v1/accounts/:id/follow", async (req, res, next) => {
  try {
    const token = req.mastodonToken;
    if (!token) {
      return res.status(401).json({ error: "The access token is invalid" });
    }

    const { id } = req.params;
    const collections = req.app.locals.mastodonCollections;
    const pluginOptions = req.app.locals.mastodonPluginOptions || {};

    // Resolve the account ID to an actor URL
    const actorUrl = await resolveActorUrl(id, collections);
    if (!actorUrl) {
      return res.status(404).json({ error: "Record not found" });
    }

    // Use the plugin's followActor method
    if (pluginOptions.followActor) {
      const result = await pluginOptions.followActor(actorUrl);
      if (!result.ok) {
        return res.status(422).json({ error: result.error || "Follow failed" });
      }
    }

    // Return relationship
    const followingIds = new Set();
    const following = await collections.ap_following.find({}).toArray();
    for (const f of following) {
      followingIds.add(remoteActorId(f.actorUrl));
    }

    const followerIds = new Set();
    const followers = await collections.ap_followers.find({}).toArray();
    for (const f of followers) {
      followerIds.add(remoteActorId(f.actorUrl));
    }

    res.json({
      id,
      following: true,
      showing_reblogs: true,
      notifying: false,
      languages: [],
      followed_by: followerIds.has(id),
      blocking: false,
      blocked_by: false,
      muting: false,
      muting_notifications: false,
      requested: false,
      requested_by: false,
      domain_blocking: false,
      endorsed: false,
      note: "",
    });
  } catch (error) {
    next(error);
  }
});

// ─── POST /api/v1/accounts/:id/unfollow ─────────────────────────────────────

router.post("/api/v1/accounts/:id/unfollow", async (req, res, next) => {
  try {
    const token = req.mastodonToken;
    if (!token) {
      return res.status(401).json({ error: "The access token is invalid" });
    }

    const { id } = req.params;
    const collections = req.app.locals.mastodonCollections;
    const pluginOptions = req.app.locals.mastodonPluginOptions || {};

    const actorUrl = await resolveActorUrl(id, collections);
    if (!actorUrl) {
      return res.status(404).json({ error: "Record not found" });
    }

    if (pluginOptions.unfollowActor) {
      const result = await pluginOptions.unfollowActor(actorUrl);
      if (!result.ok) {
        return res.status(422).json({ error: result.error || "Unfollow failed" });
      }
    }

    const followerIds = new Set();
    const followers = await collections.ap_followers.find({}).toArray();
    for (const f of followers) {
      followerIds.add(remoteActorId(f.actorUrl));
    }

    res.json({
      id,
      following: false,
      showing_reblogs: true,
      notifying: false,
      languages: [],
      followed_by: followerIds.has(id),
      blocking: false,
      blocked_by: false,
      muting: false,
      muting_notifications: false,
      requested: false,
      requested_by: false,
      domain_blocking: false,
      endorsed: false,
      note: "",
    });
  } catch (error) {
    next(error);
  }
});

// ─── POST /api/v1/accounts/:id/mute ────────────────────────────────────────

router.post("/api/v1/accounts/:id/mute", async (req, res, next) => {
  try {
    const token = req.mastodonToken;
    if (!token) {
      return res.status(401).json({ error: "The access token is invalid" });
    }

    const { id } = req.params;
    const collections = req.app.locals.mastodonCollections;

    const actorUrl = await resolveActorUrl(id, collections);
    if (actorUrl && collections.ap_muted) {
      await collections.ap_muted.updateOne(
        { url: actorUrl },
        { $set: { url: actorUrl, createdAt: new Date().toISOString() } },
        { upsert: true },
      );
    }

    res.json({
      id,
      following: false,
      showing_reblogs: true,
      notifying: false,
      languages: [],
      followed_by: false,
      blocking: false,
      blocked_by: false,
      muting: true,
      muting_notifications: true,
      requested: false,
      requested_by: false,
      domain_blocking: false,
      endorsed: false,
      note: "",
    });
  } catch (error) {
    next(error);
  }
});

// ─── POST /api/v1/accounts/:id/unmute ───────────────────────────────────────

router.post("/api/v1/accounts/:id/unmute", async (req, res, next) => {
  try {
    const token = req.mastodonToken;
    if (!token) {
      return res.status(401).json({ error: "The access token is invalid" });
    }

    const { id } = req.params;
    const collections = req.app.locals.mastodonCollections;

    const actorUrl = await resolveActorUrl(id, collections);
    if (actorUrl && collections.ap_muted) {
      await collections.ap_muted.deleteOne({ url: actorUrl });
    }

    res.json({
      id,
      following: false,
      showing_reblogs: true,
      notifying: false,
      languages: [],
      followed_by: false,
      blocking: false,
      blocked_by: false,
      muting: false,
      muting_notifications: false,
      requested: false,
      requested_by: false,
      domain_blocking: false,
      endorsed: false,
      note: "",
    });
  } catch (error) {
    next(error);
  }
});

// ─── POST /api/v1/accounts/:id/block ───────────────────────────────────────

router.post("/api/v1/accounts/:id/block", async (req, res, next) => {
  try {
    const token = req.mastodonToken;
    if (!token) {
      return res.status(401).json({ error: "The access token is invalid" });
    }

    const { id } = req.params;
    const collections = req.app.locals.mastodonCollections;

    const actorUrl = await resolveActorUrl(id, collections);
    if (actorUrl && collections.ap_blocked) {
      await collections.ap_blocked.updateOne(
        { url: actorUrl },
        { $set: { url: actorUrl, createdAt: new Date().toISOString() } },
        { upsert: true },
      );
    }

    res.json({
      id,
      following: false,
      showing_reblogs: true,
      notifying: false,
      languages: [],
      followed_by: false,
      blocking: true,
      blocked_by: false,
      muting: false,
      muting_notifications: false,
      requested: false,
      requested_by: false,
      domain_blocking: false,
      endorsed: false,
      note: "",
    });
  } catch (error) {
    next(error);
  }
});

// ─── POST /api/v1/accounts/:id/unblock ──────────────────────────────────────

router.post("/api/v1/accounts/:id/unblock", async (req, res, next) => {
  try {
    const token = req.mastodonToken;
    if (!token) {
      return res.status(401).json({ error: "The access token is invalid" });
    }

    const { id } = req.params;
    const collections = req.app.locals.mastodonCollections;

    const actorUrl = await resolveActorUrl(id, collections);
    if (actorUrl && collections.ap_blocked) {
      await collections.ap_blocked.deleteOne({ url: actorUrl });
    }

    res.json({
      id,
      following: false,
      showing_reblogs: true,
      notifying: false,
      languages: [],
      followed_by: false,
      blocking: false,
      blocked_by: false,
      muting: false,
      muting_notifications: false,
      requested: false,
      requested_by: false,
      domain_blocking: false,
      endorsed: false,
      note: "",
    });
  } catch (error) {
    next(error);
  }
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Resolve an account ID back to an actor URL by scanning followers/following.
 */
async function resolveActorUrl(id, collections) {
  // Check if it's the local profile
  const profile = await collections.ap_profile.findOne({});
  if (profile && profile._id.toString() === id) {
    return profile.url;
  }

  // Check followers
  const followers = await collections.ap_followers.find({}).toArray();
  for (const f of followers) {
    if (remoteActorId(f.actorUrl) === id) {
      return f.actorUrl;
    }
  }

  // Check following
  const following = await collections.ap_following.find({}).toArray();
  for (const f of following) {
    if (remoteActorId(f.actorUrl) === id) {
      return f.actorUrl;
    }
  }

  return null;
}

export default router;
