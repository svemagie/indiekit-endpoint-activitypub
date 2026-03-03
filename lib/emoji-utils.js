/**
 * Custom emoji replacement for fediverse content.
 *
 * Replaces :shortcode: patterns with <img> tags for custom emoji.
 * Must be called AFTER sanitizeContent() — the inserted <img> tags
 * would be stripped if run through the sanitizer.
 */

/**
 * Escape special regex characters in a string.
 * @param {string} str
 * @returns {string}
 */
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Replace :shortcode: patterns in HTML with custom emoji <img> tags.
 *
 * @param {string} html - HTML string (already sanitized)
 * @param {Array<{shortcode: string, url: string}>} emojis - Custom emoji list
 * @returns {string} HTML with emoji shortcodes replaced by img tags
 */
export function replaceCustomEmoji(html, emojis) {
  if (!html || !emojis?.length) return html;

  for (const emoji of emojis) {
    if (!emoji.shortcode || !emoji.url) continue;
    const pattern = new RegExp(`:${escapeRegex(emoji.shortcode)}:`, "g");
    html = html.replace(
      pattern,
      `<img src="${emoji.url}" alt=":${emoji.shortcode}:" title=":${emoji.shortcode}:" class="ap-custom-emoji" loading="lazy">`,
    );
  }

  return html;
}
