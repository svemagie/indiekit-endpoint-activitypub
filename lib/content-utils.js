/**
 * Content post-processing utilities.
 * Applied after sanitization and emoji replacement in the item pipeline.
 */

/**
 * Shorten displayed URLs in <a> tags that exceed maxLength.
 * Keeps the full URL in href, only truncates the visible text.
 *
 * Example: <a href="https://example.com/very/long/path">https://example.com/very/long/path</a>
 *       → <a href="https://example.com/very/long/path" title="https://example.com/very/long/path">example.com/very/lon…</a>
 *
 * @param {string} html - Sanitized HTML content
 * @param {number} [maxLength=30] - Max visible URL length before truncation
 * @returns {string} HTML with shortened display URLs
 */
export function shortenDisplayUrls(html, maxLength = 30) {
  if (!html) return html;

  // Match <a ...>URL text</a> where the visible text looks like a URL
  return html.replace(
    /(<a\s[^>]*>)(https?:\/\/[^<]+)(<\/a>)/gi,
    (match, openTag, urlText, closeTag) => {
      if (urlText.length <= maxLength) return match;

      // Strip protocol for display
      const display = urlText.replace(/^https?:\/\//, "");
      const truncated = display.slice(0, maxLength - 1) + "\u2026";

      // Add title attribute with full URL for hover tooltip (if not already present)
      let tag = openTag;
      if (!tag.includes("title=")) {
        tag = tag.replace(/>$/, ` title="${urlText}">`);
      }

      return `${tag}${truncated}${closeTag}`;
    },
  );
}

/**
 * Collapse paragraphs that are mostly hashtag links (hashtag stuffing).
 * Detects <p> blocks where 80%+ of the text content is hashtag links
 * and wraps them in a <details> element.
 *
 * @param {string} html - Sanitized HTML content
 * @param {number} [minTags=3] - Minimum number of hashtag links to trigger collapse
 * @returns {string} HTML with hashtag-heavy paragraphs collapsed
 */
export function collapseHashtagStuffing(html, minTags = 3) {
  if (!html) return html;

  // Match <p> blocks
  return html.replace(/<p>([^]*?)<\/p>/gi, (match, inner) => {
    // Count hashtag links: <a ...>#something</a> or plain #word
    const hashtagLinks = inner.match(/<a[^>]*>#[^<]+<\/a>/gi) || [];
    if (hashtagLinks.length < minTags) return match;

    // Calculate what fraction of text content is hashtags
    const textOnly = inner.replace(/<[^>]*>/g, "").trim();
    const hashtagText = hashtagLinks
      .map((link) => link.replace(/<[^>]*>/g, "").trim())
      .join(" ");

    // If hashtags make up 80%+ of the text content, collapse
    if (hashtagText.length / Math.max(textOnly.length, 1) >= 0.8) {
      return `<details class="ap-hashtag-overflow"><summary>Show ${hashtagLinks.length} tags</summary><p>${inner}</p></details>`;
    }

    return match;
  });
}
