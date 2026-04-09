/**
 * Plugin settings — stored in ap_settings MongoDB collection.
 *
 * getSettings() merges DB values over hardcoded defaults.
 * Consumers call this once per operation (or use cached middleware for hot paths).
 */

export const DEFAULTS = {
  // Instance & Client API
  instanceLanguages: ["en"],
  maxCharacters: 5000,
  maxMediaAttachments: 4,
  defaultVisibility: "public",
  defaultLanguage: "en",

  // Federation & Delivery
  timelineRetention: 1000,
  notificationRetentionDays: 30,
  activityRetentionDays: 90,
  replyChainDepth: 5,
  broadcastBatchSize: 25,
  broadcastBatchDelay: 5000,
  parallelWorkers: 5,
  logLevel: "warning",

  // Migration
  refollowBatchSize: 10,
  refollowDelay: 3000,
  refollowBatchDelay: 30000,

  // Security
  refreshTokenTtlDays: 90,
};

/**
 * Load settings from MongoDB, merged over defaults.
 *
 * @param {Map|object} collections - Indiekit collections map or plain object with ap_settings
 * @returns {Promise<object>} Settings object with all keys guaranteed present
 */
export async function getSettings(collections) {
  const col = collections?.get
    ? collections.get("ap_settings")
    : collections?.ap_settings;
  if (!col) return { ...DEFAULTS };

  try {
    const doc = await col.findOne({});
    return { ...DEFAULTS, ...(doc?.settings || {}) };
  } catch {
    return { ...DEFAULTS };
  }
}

/**
 * Save settings to MongoDB.
 *
 * @param {Map|object} collections - Indiekit collections map or plain object
 * @param {object} settings - Settings object (all keys from DEFAULTS)
 */
export async function saveSettings(collections, settings) {
  const col = collections?.get
    ? collections.get("ap_settings")
    : collections?.ap_settings;
  if (!col) return;

  await col.updateOne(
    {},
    { $set: { settings, updatedAt: new Date().toISOString() } },
    { upsert: true },
  );
}
