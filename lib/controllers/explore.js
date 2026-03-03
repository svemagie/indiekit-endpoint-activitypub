/**
 * Explore controller — browse public timelines from remote Mastodon-compatible instances.
 *
 * All remote API calls are server-side (no CORS issues).
 * Remote HTML is always passed through sanitizeContent() before storage.
 */

import { searchInstances, checkInstanceTimeline, getPopularAccounts } from "../fedidb.js";
import { getToken } from "../csrf.js";
import { validateInstance, validateHashtag, mapMastodonStatusToItem } from "./explore-utils.js";
import { postProcessItems, renderItemCards } from "../item-processing.js";

const FETCH_TIMEOUT_MS = 10_000;
const MAX_RESULTS = 20;

// Re-export validateInstance for backward compatibility (used by tabs.js, index.js)
export { validateInstance } from "./explore-utils.js";

/**
 * Fetch statuses from a remote Mastodon-compatible instance.
 *
 * @param {string} instance - Validated hostname
 * @param {object} options
 * @param {string} [options.scope] - "local" or "federated"
 * @param {string} [options.hashtag] - Validated hashtag (no #)
 * @param {string} [options.maxId] - Pagination cursor
 * @param {number} [options.limit] - Max results
 * @returns {Promise<{ items: Array, nextMaxId: string|null }>}
 */
export async function fetchMastodonTimeline(instance, { scope = "local", hashtag, maxId, limit = MAX_RESULTS } = {}) {
  const isLocal = scope === "local";
  let apiUrl;
  if (hashtag) {
    apiUrl = new URL(`https://${instance}/api/v1/timelines/tag/${encodeURIComponent(hashtag)}`);
  } else {
    apiUrl = new URL(`https://${instance}/api/v1/timelines/public`);
  }
  apiUrl.searchParams.set("local", isLocal ? "true" : "false");
  apiUrl.searchParams.set("limit", String(limit));
  if (maxId) apiUrl.searchParams.set("max_id", maxId);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  const fetchRes = await fetch(apiUrl.toString(), {
    headers: { Accept: "application/json" },
    signal: controller.signal,
  });
  clearTimeout(timeoutId);

  if (!fetchRes.ok) {
    throw new Error(`Remote instance returned HTTP ${fetchRes.status}`);
  }

  const statuses = await fetchRes.json();
  if (!Array.isArray(statuses)) {
    throw new Error("Unexpected API response format");
  }

  const items = statuses.map((s) => mapMastodonStatusToItem(s, instance));

  const nextMaxId =
    statuses.length === limit && statuses.length > 0
      ? statuses[statuses.length - 1].id || null
      : null;

  return { items, nextMaxId };
}

export function exploreController(mountPath) {
  return async (request, response, next) => {
    try {
      const rawInstance = request.query.instance || "";
      const scope = request.query.scope === "federated" ? "federated" : "local";
      const maxId = request.query.max_id || "";
      const rawHashtag = request.query.hashtag || "";
      const hashtag = rawHashtag ? validateHashtag(rawHashtag) : null;

      const csrfToken = getToken(request.session);
      const readerParent = { href: `${mountPath}/admin/reader`, text: response.locals.__("activitypub.reader.title") };

      // No instance specified — render clean initial page (no error)
      if (!rawInstance.trim()) {
        return response.render("activitypub-explore", {
          title: response.locals.__("activitypub.reader.explore.title"),
          readerParent,
          instance: "",
          scope,
          hashtag: hashtag || "",
          items: [],
          maxId: null,
          error: null,
          mountPath,
          csrfToken,
        });
      }

      const instance = validateInstance(rawInstance);
      if (!instance) {
        return response.render("activitypub-explore", {
          title: response.locals.__("activitypub.reader.explore.title"),
          readerParent,
          instance: rawInstance,
          scope,
          hashtag: hashtag || "",
          items: [],
          maxId: null,
          error: response.locals.__("activitypub.reader.explore.invalidInstance"),
          mountPath,
          csrfToken,
        });
      }

      let items = [];
      let nextMaxId = null;
      let error = null;

      try {
        const result = await fetchMastodonTimeline(instance, { scope, hashtag, maxId });
        const processed = await postProcessItems(result.items);
        items = processed.items;
        nextMaxId = result.nextMaxId;
      } catch (fetchError) {
        const msg = fetchError.name === "AbortError"
          ? response.locals.__("activitypub.reader.explore.timeout")
          : response.locals.__("activitypub.reader.explore.loadError");
        error = msg;
      }

      response.render("activitypub-explore", {
        title: response.locals.__("activitypub.reader.explore.title"),
        readerParent,
        instance,
        scope,
        hashtag: hashtag || "",
        items,
        maxId: nextMaxId,
        error,
        mountPath,
        csrfToken,
        interactionMap: {},
      });
    } catch (error) {
      next(error);
    }
  };
}

/**
 * AJAX API endpoint for explore page infinite scroll.
 * Returns JSON { html, maxId }.
 */
export function exploreApiController(mountPath) {
  return async (request, response, next) => {
    try {
      const rawInstance = request.query.instance || "";
      const scope = request.query.scope === "federated" ? "federated" : "local";
      const maxId = request.query.max_id || "";
      const rawHashtag = request.query.hashtag || "";
      const hashtag = rawHashtag ? validateHashtag(rawHashtag) : null;

      const instance = validateInstance(rawInstance);
      if (!instance) {
        return response.status(400).json({ error: "Invalid instance" });
      }

      const { items: rawItems, nextMaxId } = await fetchMastodonTimeline(instance, { scope, hashtag, maxId });
      const { items } = await postProcessItems(rawItems);

      const csrfToken = getToken(request.session);
      const html = await renderItemCards(items, request, {
        ...response.locals,
        mountPath,
        csrfToken,
        interactionMap: {},
      });

      response.json({ html, maxId: nextMaxId });
    } catch (error) {
      next(error);
    }
  };
}

/**
 * AJAX API endpoint for instance autocomplete.
 * Returns JSON array of matching instances from FediDB.
 */
export function instanceSearchApiController(mountPath) {
  return async (request, response, next) => {
    try {
      const q = (request.query.q || "").trim();
      if (!q || q.length < 2) {
        return response.json([]);
      }

      const results = await searchInstances(q, 8);
      response.json(results);
    } catch (error) {
      next(error);
    }
  };
}

/**
 * AJAX API endpoint to check if an instance supports public timeline exploration.
 * Returns JSON { supported: boolean, error: string|null }.
 */
export function instanceCheckApiController(mountPath) {
  return async (request, response, next) => {
    try {
      const domain = (request.query.domain || "").trim().toLowerCase();
      if (!domain) {
        return response.status(400).json({ supported: false, error: "Missing domain" });
      }

      // Validate domain to prevent SSRF
      const validated = validateInstance(domain);
      if (!validated) {
        return response.status(400).json({ supported: false, error: "Invalid domain" });
      }

      const result = await checkInstanceTimeline(validated);
      response.json(result);
    } catch (error) {
      next(error);
    }
  };
}

/**
 * AJAX API endpoint for popular fediverse accounts.
 * Returns the full cached list; client-side filtering via Alpine.js.
 */
export function popularAccountsApiController(mountPath) {
  return async (request, response, next) => {
    try {
      const accounts = await getPopularAccounts(50);
      response.json(accounts);
    } catch (error) {
      next(error);
    }
  };
}
