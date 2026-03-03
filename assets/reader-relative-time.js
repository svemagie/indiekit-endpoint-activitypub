/**
 * Relative timestamps — Alpine.js directive that converts absolute
 * datetime attributes to human-friendly relative strings.
 *
 * Usage: <time datetime="2026-03-03T12:00:00Z" x-data x-relative-time>...</time>
 *
 * The server-rendered absolute time stays as fallback for no-JS clients.
 * Alpine enhances it to relative on hydration, updates every 60s for
 * recent posts, and shows the absolute time on hover via title attribute.
 *
 * Format rules (matching Mastodon/Elk conventions):
 *   < 1 minute:   "just now"
 *   < 60 minutes: "Xm"  (e.g. "5m")
 *   < 24 hours:   "Xh"  (e.g. "3h")
 *   < 7 days:     "Xd"  (e.g. "2d")
 *   same year:    "Mar 3"
 *   older:        "Mar 3, 2025"
 */

document.addEventListener("alpine:init", () => {
  // eslint-disable-next-line no-undef
  Alpine.directive("relative-time", (el) => {
    const iso = el.getAttribute("datetime");
    if (!iso) return;

    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return;

    // Store the original formatted text as the title (hover tooltip)
    const original = el.textContent.trim();
    if (original && !el.getAttribute("title")) {
      el.setAttribute("title", original);
    }

    function update() {
      el.textContent = formatRelative(date);
    }

    update();

    // Only set up interval for recent posts (< 24h old)
    const ageMs = Date.now() - date.getTime();
    if (ageMs < 86_400_000) {
      const interval = setInterval(() => {
        update();
        // Stop updating once older than 24h
        if (Date.now() - date.getTime() >= 86_400_000) {
          clearInterval(interval);
        }
      }, 60_000);
    }
  });
});

/**
 * Format a Date as a relative time string.
 * @param {Date} date
 * @returns {string}
 */
function formatRelative(date) {
  const now = Date.now();
  const diffMs = now - date.getTime();
  const diffSec = Math.floor(diffMs / 1000);

  if (diffSec < 60) return "just now";

  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m`;

  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour}h`;

  const diffDay = Math.floor(diffHour / 24);
  if (diffDay < 7) return `${diffDay}d`;

  // Older than 7 days — use formatted date
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const month = months[date.getMonth()];
  const day = date.getDate();

  if (date.getFullYear() === new Date().getFullYear()) {
    return `${month} ${day}`;
  }

  return `${month} ${day}, ${date.getFullYear()}`;
}
