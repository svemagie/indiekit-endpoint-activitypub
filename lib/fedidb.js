/**
 * FediDB API client with Redis caching.
 *
 * Wraps https://api.fedidb.org/v1/ endpoints:
 * - /servers — cursor-paginated list of known fediverse instances (ranked by size)
 * - /popular-accounts — top accounts by follower count
 *
 * NOTE: The /servers endpoint ignores query params (q, search, name) and always
 * returns the same ranked list. We paginate through ~500 servers, cache the full
 * corpus for 24 hours, and filter locally when the user searches.
 *
 * Cache TTL: 24 hours for both datasets (enforced by Redis TTL).
 */

import { cacheGet, cacheSet } from "./redis-cache.js";

const API_BASE = "https://api.fedidb.org/v1";
const FETCH_TIMEOUT_MS = 8_000;
const CACHE_TTL_SECONDS = 24 * 60 * 60; // 24 hours

/**
 * Fetch with timeout helper.
 * @param {string} url
 * @returns {Promise<Response>}
 */
async function fetchWithTimeout(url) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    return res;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Fetch the FediDB server catalogue by paginating through cursor-based results.
 * Cached for 24 hours as a single entry. The API ignores the `q` param and
 * always returns a ranked list, so we collect a large corpus and filter locally.
 *
 * Paginates up to MAX_PAGES (13 pages × 40 = ~520 servers), which covers
 * all well-known instances. Results are cached in Redis for 24 hours.
 *
 * @returns {Promise<Array>}
 */
const MAX_PAGES = 13;

async function getAllServers() {
  const cacheKey = "fedidb:servers-all";
  const cached = await cacheGet(cacheKey);
  if (cached) return cached;

  const results = [];

  try {
    let cursor = null;

    for (let page = 0; page < MAX_PAGES; page++) {
      let url = `${API_BASE}/servers?limit=40`;
      if (cursor) url += `&cursor=${cursor}`;

      const res = await fetchWithTimeout(url);
      if (!res.ok) break;

      const json = await res.json();
      const servers = json.data || [];
      if (servers.length === 0) break;

      for (const s of servers) {
        results.push({
          domain: s.domain,
          software: s.software?.name || "Unknown",
          description: s.description || "",
          mau: s.stats?.monthly_active_users || 0,
          userCount: s.stats?.user_count || 0,
          openRegistration: s.open_registration || false,
        });
      }

      cursor = json.meta?.next_cursor;
      if (!cursor) break;
    }

    if (results.length > 0) {
      await cacheSet(cacheKey, results, CACHE_TTL_SECONDS);
    }
  } catch {
    // Return whatever we collected so far
  }

  return results;
}

/**
 * Search FediDB for instances matching a query.
 * Returns a flat array of { domain, software, description, mau, openRegistration }.
 *
 * Fetches the full server list once (cached 24h) and filters by domain/software match.
 *
 * @param {string} query - Search term (e.g. "mast")
 * @param {number} [limit=10] - Max results
 * @returns {Promise<Array>}
 */
export async function searchInstances(query, limit = 10) {
  const q = (query || "").trim().toLowerCase();
  if (!q) return [];

  const allServers = await getAllServers();

  return allServers
    .filter(
      (s) =>
        s.domain.toLowerCase().includes(q) ||
        s.software.toLowerCase().includes(q),
    )
    .slice(0, limit);
}

/**
 * Check if a remote instance supports unauthenticated public timeline access.
 * Makes a lightweight HEAD-like request (limit=1) to the Mastodon public timeline API.
 *
 * Cached per domain for 24 hours.
 *
 * @param {string} domain - Instance hostname
 * @returns {Promise<{ supported: boolean, error: string|null }>}
 */
export async function checkInstanceTimeline(domain) {
  const cacheKey = `fedidb:timeline-check:${domain}`;
  const cached = await cacheGet(cacheKey);
  if (cached) return cached;

  try {
    const url = `https://${domain}/api/v1/timelines/public?local=true&limit=1`;
    const res = await fetchWithTimeout(url);

    let result;
    if (res.ok) {
      result = { supported: true, error: null };
    } else {
      let errorMsg = `HTTP ${res.status}`;
      try {
        const body = await res.json();
        if (body.error) errorMsg = body.error;
      } catch {
        // Can't parse body
      }
      result = { supported: false, error: errorMsg };
    }

    await cacheSet(cacheKey, result, CACHE_TTL_SECONDS);
    return result;
  } catch {
    return { supported: false, error: "Connection failed" };
  }
}

/**
 * Fetch popular fediverse accounts from FediDB.
 * Returns a flat array of { username, name, domain, handle, url, avatar, followers, bio }.
 *
 * Cached for 24 hours (single cache entry).
 *
 * @param {number} [limit=50] - Max accounts to fetch
 * @returns {Promise<Array>}
 */
export async function getPopularAccounts(limit = 50) {
  const cacheKey = `fedidb:popular-accounts:${limit}`;
  const cached = await cacheGet(cacheKey);
  if (cached) return cached;

  try {
    const url = `${API_BASE}/popular-accounts?limit=${limit}`;
    const res = await fetchWithTimeout(url);
    if (!res.ok) return [];

    const json = await res.json();
    const accounts = json.data || [];

    const results = accounts.map((a) => ({
      username: a.username || "",
      name: a.name || a.username || "",
      domain: a.domain || "",
      handle: `@${a.username}@${a.domain}`,
      url: a.account_url || "",
      avatar: a.avatar_url || "",
      followers: a.followers_count || 0,
      bio: (a.bio || "").replace(/<[^>]*>/g, "").slice(0, 120),
    }));

    await cacheSet(cacheKey, results, CACHE_TTL_SECONDS);
    return results;
  } catch {
    return [];
  }
}
