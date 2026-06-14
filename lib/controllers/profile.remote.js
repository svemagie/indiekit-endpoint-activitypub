/**
 * Remote profile controllers — view remote actors and follow/unfollow.
 */

import { getToken, validateToken } from "../csrf.js";
import { sanitizeContent } from "../timeline-store.js";
import { lookupWithSecurity } from "../lookup-helpers.js";
import { assertLookupAllowed } from "../ssrf-guard.js";

/**
 * GET /admin/reader/profile — Show remote actor profile.
 * @param {string} mountPath - Plugin mount path
 * @param {object} plugin - ActivityPub plugin instance
 */
export function remoteProfileController(mountPath, plugin) {
  return async (request, response, next) => {
    try {
      const { application } = request.app.locals;
      const actorUrl = request.query.url || request.query.handle;

      if (!actorUrl) {
        return response.status(400).render("error", {
          title: "Error",
          content: "Missing actor URL or handle",
        });
      }

      // Reject non-http(s) schemes and loopback/private-range hosts
      try {
        const _parsed = new URL(actorUrl);
        if (!["http:", "https:"].includes(_parsed.protocol)) {
          return response.status(400).render("error", { title: "Error", content: "Invalid actor URL" });
        }
        const _h = _parsed.hostname;
        if (_h === "localhost" || _h === "127.0.0.1" || _h === "::1" || /^10\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\./.test(_h)) {
          return response.status(400).render("error", { title: "Error", content: "Invalid actor URL" });
        }
      } catch {
        return response.status(400).render("error", { title: "Error", content: "Invalid actor URL" });
      }

      if (!plugin._federation) {
        return response.status(503).render("error", {
          title: "Error",
          content: "Federation not initialized",
        });
      }

      const handle = plugin.options.actor.handle;
      const ctx = plugin._federation.createContext(
        new URL(plugin._publicationUrl),
        { handle, publicationUrl: plugin._publicationUrl },
      );

      // Look up the remote actor (signed request for Authorized Fetch)
      let actor;
      try {
        const documentLoader = await ctx.getDocumentLoader({ identifier: handle });
        actor = await lookupWithSecurity(ctx, new URL(actorUrl), { documentLoader });
      } catch (lookupError) {
        console.warn(`[ActivityPub] Remote profile lookup failed for ${actorUrl}:`, lookupError?.message);
        return response.status(404).render("error", {
          title: "Error",
          content: response.locals.__("activitypub.profile.remote.notFound"),
        });
      }

      if (!actor) {
        return response.status(404).render("error", {
          title: "Error",
          content: response.locals.__("activitypub.profile.remote.notFound"),
        });
      }

      // Extract actor info
      const name =
        actor.name?.toString() ||
        actor.preferredUsername?.toString() ||
        actorUrl;
      const actorHandle = actor.preferredUsername?.toString() || "";
      const bio = sanitizeContent(actor.summary?.toString() || "");
      let icon = "";
      let image = "";

      try {
        const iconObj = await actor.getIcon();
        icon = iconObj?.url?.href || "";
      } catch {
        // No icon
      }

      try {
        const imageObj = await actor.getImage();
        image = imageObj?.url?.href || "";
      } catch {
        // No header image
      }

      // Extract host for "View on {instance}"
      let instanceHost = "";

      try {
        instanceHost = new URL(actorUrl).hostname;
      } catch {
        // Invalid URL
      }

      // Check if we're following this actor
      const followingCol = application?.collections?.get("ap_following");
      const isFollowing = followingCol
        ? !!(await followingCol.findOne({ actorUrl }))
        : false;

      // Get their posts from our timeline (only if following)
      let posts = [];

      if (isFollowing) {
        const timelineCol = application?.collections?.get("ap_timeline");

        if (timelineCol) {
          posts = await timelineCol
            .find({ "author.url": actorUrl })
            .sort({ published: -1 })
            .limit(20)
            .toArray();
        }
      }

      // Check mute/block state
      const mutedCol = application?.collections?.get("ap_muted");
      const blockedCol = application?.collections?.get("ap_blocked");
      const isMuted = mutedCol
        ? !!(await mutedCol.findOne({ url: actorUrl }))
        : false;
      const isBlocked = blockedCol
        ? !!(await blockedCol.findOne({ url: actorUrl }))
        : false;

      const csrfToken = getToken(request.session);

      response.render("activitypub-remote-profile", {
        title: name,
        readerParent: { href: `${mountPath}/admin/reader`, text: response.locals.__("activitypub.reader.title") },
        actorUrl,
        name,
        actorHandle,
        bio,
        icon,
        image,
        instanceHost,
        isFollowing,
        isMuted,
        isBlocked,
        posts,
        csrfToken,
        mountPath,
      });
    } catch (error) {
      next(error);
    }
  };
}

/**
 * POST /admin/reader/follow — Follow a remote actor.
 */
export function followController(mountPath, plugin) {
  return async (request, response, next) => {
    try {
      if (!validateToken(request)) {
        return response.status(403).json({
          success: false,
          error: "Invalid CSRF token",
        });
      }

      const { url } = request.body;

      if (!url) {
        return response.status(400).json({ success: false, error: "Missing actor URL" });
      }

      // DNS-resolving SSRF guard (replaces a string-prefix check that missed
      // 169.254/100.64/IPv6 and was DNS-rebinding bypassable). A remote actor
      // to follow is never own-host → blanket private block (no ownHost).
      try {
        await assertLookupAllowed(url);
      } catch {
        return response.status(400).json({ success: false, error: "Invalid actor URL" });
      }

      const result = await plugin.followActor(url);

      return response.json({
        success: result.ok,
        error: result.error || undefined,
      });
    } catch (error) {
      return response.status(500).json({
        success: false,
        error: "Operation failed. Please try again later.",
      });
    }
  };
}

/**
 * POST /admin/reader/unfollow — Unfollow a remote actor.
 */
export function unfollowController(mountPath, plugin) {
  return async (request, response, next) => {
    try {
      if (!validateToken(request)) {
        return response.status(403).json({
          success: false,
          error: "Invalid CSRF token",
        });
      }

      const { url } = request.body;

      if (!url) {
        return response.status(400).json({
          success: false,
          error: "Missing actor URL",
        });
      }

      // SSRF guard — unfollowController previously had zero URL validation.
      try {
        await assertLookupAllowed(url);
      } catch {
        return response.status(400).json({ success: false, error: "Invalid actor URL" });
      }

      const result = await plugin.unfollowActor(url);

      return response.json({
        success: result.ok,
        error: result.error || undefined,
      });
    } catch (error) {
      return response.status(500).json({
        success: false,
        error: "Operation failed. Please try again later.",
      });
    }
  };
}
