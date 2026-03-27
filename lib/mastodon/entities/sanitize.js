/**
 * HTML sanitizer for Mastodon Client API responses.
 *
 * Uses the sanitize-html library for robust XSS prevention.
 * Preserves safe markup that Mastodon clients expect (links,
 * paragraphs, line breaks, inline formatting, mentions, hashtags).
 */
import sanitizeHtmlLib from "sanitize-html";

/**
 * Sanitize HTML content for safe inclusion in API responses.
 * @param {string} html - Raw HTML string
 * @returns {string} Sanitized HTML
 */
export function sanitizeHtml(html) {
  if (!html || typeof html !== "string") return "";

  return sanitizeHtmlLib(html, {
    allowedTags: [
      "a", "br", "p", "span", "strong", "em", "b", "i", "u", "s",
      "del", "pre", "code", "blockquote", "ul", "ol", "li",
    ],
    allowedAttributes: {
      a: ["href", "rel", "class", "target"],
      span: ["class"],
    },
    allowedSchemes: ["http", "https", "mailto"],
  });
}

/**
 * Strip all HTML tags, returning plain text.
 * @param {string} html
 * @returns {string}
 */
export function stripHtml(html) {
  if (!html || typeof html !== "string") return "";
  return sanitizeHtmlLib(html, {
    allowedTags: [],
    allowedAttributes: {},
  }).trim();
}
