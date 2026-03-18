/**
 * Mastodon-compatible cursor pagination helpers.
 *
 * Uses MongoDB ObjectId as cursor (chronologically ordered).
 * Emits RFC 8288 Link headers that masto.js / Phanpy parse.
 */
import { ObjectId } from "mongodb";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 40;

/**
 * Parse and clamp the limit parameter.
 *
 * @param {string|number} raw - Raw limit value from query string
 * @returns {number}
 */
export function parseLimit(raw) {
  const n = Number.parseInt(String(raw), 10);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_LIMIT;
  return Math.min(n, MAX_LIMIT);
}

/**
 * Build a MongoDB filter object for cursor-based pagination.
 *
 * Mastodon cursor params (all optional, applied to `_id`):
 *   max_id   — return items older than this ID (exclusive)
 *   min_id   — return items newer than this ID (exclusive), closest first
 *   since_id — return items newer than this ID (exclusive), most recent first
 *
 * @param {object} baseFilter - Existing MongoDB filter to extend
 * @param {object} cursors
 * @param {string} [cursors.max_id]
 * @param {string} [cursors.min_id]
 * @param {string} [cursors.since_id]
 * @returns {{ filter: object, sort: object, reverse: boolean }}
 */
export function buildPaginationQuery(baseFilter, { max_id, min_id, since_id } = {}) {
  const filter = { ...baseFilter };
  let sort = { _id: -1 }; // newest first (default)
  let reverse = false;

  if (max_id) {
    try {
      filter._id = { ...filter._id, $lt: new ObjectId(max_id) };
    } catch {
      // Invalid ObjectId — ignore
    }
  }

  if (since_id) {
    try {
      filter._id = { ...filter._id, $gt: new ObjectId(since_id) };
    } catch {
      // Invalid ObjectId — ignore
    }
  }

  if (min_id) {
    try {
      filter._id = { ...filter._id, $gt: new ObjectId(min_id) };
      // min_id returns results closest to the cursor, so sort ascending
      // then reverse the results before returning
      sort = { _id: 1 };
      reverse = true;
    } catch {
      // Invalid ObjectId — ignore
    }
  }

  return { filter, sort, reverse };
}

/**
 * Set the Link pagination header on an Express response.
 *
 * @param {object} res - Express response object
 * @param {object} req - Express request object (for building URLs)
 * @param {Array} items - Result items (must have `_id` or `id`)
 * @param {number} limit - The limit used for the query
 */
export function setPaginationHeaders(res, req, items, limit) {
  if (!items?.length) return;

  // Only emit Link if we got a full page (may have more)
  if (items.length < limit) return;

  const firstId = itemId(items[0]);
  const lastId = itemId(items[items.length - 1]);

  if (!firstId || !lastId) return;

  const baseUrl = `${req.protocol}://${req.get("host")}${req.path}`;

  // Preserve existing query params (like types[] for notifications)
  const existingParams = new URLSearchParams();
  for (const [key, value] of Object.entries(req.query)) {
    if (key === "max_id" || key === "min_id" || key === "since_id") continue;
    if (Array.isArray(value)) {
      for (const v of value) existingParams.append(key, v);
    } else {
      existingParams.set(key, String(value));
    }
  }

  const links = [];

  // rel="next" — older items (max_id = last item's ID)
  const nextParams = new URLSearchParams(existingParams);
  nextParams.set("max_id", lastId);
  links.push(`<${baseUrl}?${nextParams.toString()}>; rel="next"`);

  // rel="prev" — newer items (min_id = first item's ID)
  const prevParams = new URLSearchParams(existingParams);
  prevParams.set("min_id", firstId);
  links.push(`<${baseUrl}?${prevParams.toString()}>; rel="prev"`);

  res.set("Link", links.join(", "));
}

/**
 * Extract the string ID from an item.
 */
function itemId(item) {
  if (!item) return null;
  if (item._id) return item._id.toString();
  if (item.id) return String(item.id);
  return null;
}
