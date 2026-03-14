/**
 * Multi-strategy author resolution for interaction delivery.
 *
 * Resolves a post URL to the author's Actor object so that Like, Announce,
 * and other activities can be delivered to the correct inbox.
 *
 * Strategies (tried in order):
 * 1. lookupObject on post URL → getAttributedTo
 * 2. Timeline/notification DB lookup → lookupObject on stored author URL
 * 3. Extract author URL from post URL pattern → lookupObject
 */

/**
 * Extract a probable author URL from a post URL using common fediverse patterns.
 *
 * @param {string} postUrl - The post URL
 * @returns {string|null} - Author URL or null
 *
 * Patterns matched:
 *   https://instance/users/USERNAME/statuses/ID  → https://instance/users/USERNAME
 *   https://instance/@USERNAME/ID                → https://instance/users/USERNAME
 *   https://instance/p/USERNAME/ID               → https://instance/users/USERNAME  (Pixelfed)
 *   https://instance/notice/ID                   → null (no username in URL)
 */
export function extractAuthorUrl(postUrl) {
  try {
    const parsed = new URL(postUrl);
    const path = parsed.pathname;

    // /users/USERNAME/statuses/ID — Mastodon, GoToSocial, Akkoma canonical
    const usersMatch = path.match(/^\/users\/([^/]+)\//);
    if (usersMatch) {
      return `${parsed.origin}/users/${usersMatch[1]}`;
    }

    // /@USERNAME/ID — Mastodon display URL
    const atMatch = path.match(/^\/@([^/]+)\/\d/);
    if (atMatch) {
      return `${parsed.origin}/users/${atMatch[1]}`;
    }

    // /p/USERNAME/ID — Pixelfed
    const pixelfedMatch = path.match(/^\/p\/([^/]+)\/\d/);
    if (pixelfedMatch) {
      return `${parsed.origin}/users/${pixelfedMatch[1]}`;
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Wraps a Fedify document loader to allow private/loopback addresses for
 * requests targeting the publication's own hostname.
 *
 * Fedify blocks requests to private IP ranges by default. When the publication
 * is self-hosted (e.g. localhost or a private IP), author lookups for posts on
 * that same host fail with a private-address error. This wrapper opts in to
 * allowPrivateAddress only when the target URL is on the publication's own host.
 *
 * @param {Function} documentLoader - Fedify authenticated document loader
 * @param {string} publicationUrl - The publication's canonical URL (e.g. ctx.url.href)
 * @returns {Function} Wrapped document loader
 */
function createPublicationAwareDocumentLoader(documentLoader, publicationUrl) {
  if (typeof documentLoader !== "function") {
    return documentLoader;
  }

  let publicationHost = "";
  try {
    publicationHost = new URL(publicationUrl).hostname;
  } catch {
    return documentLoader;
  }

  return (url, options = {}) => {
    try {
      const parsed = new URL(
        typeof url === "string" ? url : (url?.href || String(url)),
      );
      if (parsed.hostname === publicationHost) {
        return documentLoader(url, { ...options, allowPrivateAddress: true });
      }
    } catch {
      // Fall through to default loader behavior.
    }

    return documentLoader(url, options);
  };
}

/**
 * Resolve the author Actor for a given post URL.
 *
 * @param {string} postUrl - The post URL to resolve the author for
 * @param {object} ctx - Fedify context
 * @param {object} documentLoader - Authenticated document loader
 * @param {object} [collections] - Optional MongoDB collections map (application.collections)
 * @returns {Promise<object|null>} - Fedify Actor object or null
 */
export async function resolveAuthor(
  postUrl,
  ctx,
  documentLoader,
  collections,
) {
  const publicationLoader = createPublicationAwareDocumentLoader(
    documentLoader,
    ctx?.url?.href || "",
  );

  // Strategy 1: Look up remote post via Fedify (signed request)
  try {
    const remoteObject = await ctx.lookupObject(new URL(postUrl), {
      documentLoader: publicationLoader,
    });
    if (remoteObject && typeof remoteObject.getAttributedTo === "function") {
      const author = await remoteObject.getAttributedTo({
        documentLoader: publicationLoader,
      });
      const recipient = Array.isArray(author) ? author[0] : author;
      if (recipient) {
        console.info(
          `[ActivityPub] Resolved author via lookupObject for ${postUrl}`,
        );
        return recipient;
      }
    }
  } catch (error) {
    console.warn(
      `[ActivityPub] lookupObject failed for ${postUrl}:`,
      error.message,
    );
  }

  // Strategy 2: Use author URL from timeline or notifications
  if (collections) {
    const ap_timeline = collections.get("ap_timeline");
    const ap_notifications = collections.get("ap_notifications");

    // Search timeline by both uid (canonical) and url (display)
    let authorUrl = null;
    if (ap_timeline) {
      const item = await ap_timeline.findOne({
        $or: [{ uid: postUrl }, { url: postUrl }],
      });
      authorUrl = item?.author?.url;
    }

    // Fall back to notifications if not in timeline
    if (!authorUrl && ap_notifications) {
      const notif = await ap_notifications.findOne({
        $or: [{ objectUrl: postUrl }, { targetUrl: postUrl }],
      });
      authorUrl = notif?.actorUrl;
    }

    if (authorUrl) {
      try {
        const actor = await ctx.lookupObject(new URL(authorUrl), {
          documentLoader: publicationLoader,
        });
        if (actor) {
          console.info(
            `[ActivityPub] Resolved author via DB for ${postUrl} → ${authorUrl}`,
          );
          return actor;
        }
      } catch (error) {
        console.warn(
          `[ActivityPub] lookupObject failed for author ${authorUrl}:`,
          error.message,
        );
      }
    }
  }

  // Strategy 3: Extract author URL from post URL pattern
  const extractedUrl = extractAuthorUrl(postUrl);
  if (extractedUrl) {
    try {
      const actor = await ctx.lookupObject(new URL(extractedUrl), {
        documentLoader: publicationLoader,
      });
      if (actor) {
        console.info(
          `[ActivityPub] Resolved author via URL pattern for ${postUrl} → ${extractedUrl}`,
        );
        return actor;
      }
    } catch (error) {
      console.warn(
        `[ActivityPub] lookupObject failed for extracted author ${extractedUrl}:`,
        error.message,
      );
    }
  }

  console.warn(`[ActivityPub] All author resolution strategies failed for ${postUrl}`);
  return null;
}
