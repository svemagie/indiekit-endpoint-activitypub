/**
 * Infinite scroll — unified AlpineJS component for AJAX load-more.
 * Works for both reader timeline and explore view via data attributes.
 *
 * Required data attributes on the component element:
 *   data-cursor        — initial pagination cursor value
 *   data-api-url       — API endpoint URL (e.g., /activitypub/admin/reader/api/timeline)
 *   data-cursor-param  — query param name for the cursor (e.g., "before" or "max_id")
 *   data-cursor-field  — response JSON field for the next cursor (e.g., "before" or "maxId")
 *   data-timeline-id   — DOM ID of the timeline container to append HTML into
 *
 * Optional:
 *   data-extra-params  — JSON-encoded object of additional query params
 *   data-hide-pagination — CSS selector of no-JS pagination to hide
 */

document.addEventListener("alpine:init", () => {
  // eslint-disable-next-line no-undef
  Alpine.data("apInfiniteScroll", () => ({
    loading: false,
    done: false,
    cursor: null,
    apiUrl: "",
    cursorParam: "before",
    cursorField: "before",
    timelineId: "",
    extraParams: {},
    observer: null,

    init() {
      const el = this.$el;
      this.cursor = el.dataset.cursor || null;
      this.apiUrl = el.dataset.apiUrl || "";
      this.cursorParam = el.dataset.cursorParam || "before";
      this.cursorField = el.dataset.cursorField || "before";
      this.timelineId = el.dataset.timelineId || "";

      // Parse extra params from JSON data attribute
      try {
        this.extraParams = JSON.parse(el.dataset.extraParams || "{}");
      } catch {
        this.extraParams = {};
      }

      // Hide the no-JS pagination fallback now that JS is active
      const hideSel = el.dataset.hidePagination;
      if (hideSel) {
        const paginationEl = document.getElementById(hideSel);
        if (paginationEl) paginationEl.style.display = "none";
      }

      if (!this.cursor) {
        this.done = true;
        return;
      }

      // Set up IntersectionObserver to auto-load when sentinel comes into view
      this.observer = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (entry.isIntersecting && !this.loading && !this.done) {
              this.loadMore();
            }
          }
        },
        { rootMargin: "200px" },
      );

      if (this.$refs.sentinel) {
        this.observer.observe(this.$refs.sentinel);
      }
    },

    async loadMore() {
      if (this.loading || this.done || !this.cursor) return;

      this.loading = true;

      const params = new URLSearchParams({
        [this.cursorParam]: this.cursor,
        ...this.extraParams,
      });

      try {
        const res = await fetch(
          `${this.apiUrl}?${params.toString()}`,
          { headers: { Accept: "application/json" } },
        );

        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        const data = await res.json();

        const timeline = this.timelineId
          ? document.getElementById(this.timelineId)
          : null;

        if (data.html && timeline) {
          timeline.insertAdjacentHTML("beforeend", data.html);
        }

        if (data[this.cursorField]) {
          this.cursor = data[this.cursorField];
        } else {
          this.done = true;
          if (this.observer) this.observer.disconnect();
        }
      } catch (err) {
        console.error("[ap-infinite-scroll] load failed:", err.message);
      } finally {
        this.loading = false;
      }
    },

    destroy() {
      if (this.observer) this.observer.disconnect();
    },
  }));

  /**
   * New posts banner — polls for new items every 30s, shows "N new posts" banner.
   */
  // eslint-disable-next-line no-undef
  Alpine.data("apNewPostsBanner", () => ({
    count: 0,
    newest: null,
    tab: "",
    mountPath: "",
    _interval: null,

    init() {
      const el = this.$el;
      this.newest = el.dataset.newest || null;
      this.tab = el.dataset.tab || "notes";
      this.mountPath = el.dataset.mountPath || "";

      if (!this.newest) return;

      this._interval = setInterval(() => this.poll(), 30000);
    },

    async poll() {
      if (!this.newest) return;
      try {
        const params = new URLSearchParams({ after: this.newest, tab: this.tab });
        const res = await fetch(
          `${this.mountPath}/admin/reader/api/timeline/count-new?${params}`,
          { headers: { Accept: "application/json" } },
        );
        if (!res.ok) return;
        const data = await res.json();
        this.count = data.count || 0;
      } catch {
        // Silently ignore polling errors
      }
    },

    async loadNew() {
      if (!this.newest || this.count === 0) return;
      try {
        const params = new URLSearchParams({ after: this.newest, tab: this.tab });
        const res = await fetch(
          `${this.mountPath}/admin/reader/api/timeline?${params}`,
          { headers: { Accept: "application/json" } },
        );
        if (!res.ok) return;
        const data = await res.json();

        const timeline = document.getElementById("ap-timeline");
        if (data.html && timeline) {
          timeline.insertAdjacentHTML("afterbegin", data.html);
          // Update newest cursor to the first item's published date
          const firstCard = timeline.querySelector(".ap-card");
          if (firstCard) {
            const timeEl = firstCard.querySelector("time[datetime]");
            if (timeEl) this.newest = timeEl.getAttribute("datetime");
          }
        }

        this.count = 0;
      } catch {
        // Silently ignore load errors
      }
    },

    destroy() {
      if (this._interval) clearInterval(this._interval);
    },
  }));

  /**
   * Read tracking — IntersectionObserver marks cards as read on 50% visibility.
   * Batches UIDs and flushes to server every 5 seconds.
   */
  // eslint-disable-next-line no-undef
  Alpine.data("apReadTracker", () => ({
    _observer: null,
    _batch: [],
    _flushTimer: null,
    _mountPath: "",
    _csrfToken: "",

    init() {
      const el = this.$el;
      this._mountPath = el.dataset.mountPath || "";
      this._csrfToken = el.dataset.csrfToken || "";

      this._observer = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (entry.isIntersecting) {
              const card = entry.target;
              const uid = card.dataset.uid;
              if (uid && !card.classList.contains("ap-card--read")) {
                // Mark read server-side but DON'T dim visually in this session.
                // Cards only appear dimmed when they arrive from the server
                // with item.read=true on a subsequent page load.
                this._batch.push(uid);
              }
              this._observer.unobserve(card);
            }
          }
        },
        { threshold: 0.5 },
      );

      // Observe all existing cards
      this._observeCards();

      // Watch for new cards added by infinite scroll
      this._mutationObserver = new MutationObserver(() => this._observeCards());
      this._mutationObserver.observe(el, { childList: true, subtree: true });

      // Flush batch every 5 seconds
      this._flushTimer = setInterval(() => this._flush(), 5000);
    },

    _observeCards() {
      const cards = this.$el.querySelectorAll(".ap-card[data-uid]:not(.ap-card--read)");
      for (const card of cards) {
        this._observer.observe(card);
      }
    },

    async _flush() {
      if (this._batch.length === 0) return;
      const uids = [...this._batch];
      this._batch = [];

      try {
        await fetch(`${this._mountPath}/admin/reader/api/timeline/mark-read`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-CSRF-Token": this._csrfToken,
          },
          body: JSON.stringify({ uids }),
        });
      } catch {
        // Non-critical — items will be re-marked on next view
      }
    },

    destroy() {
      if (this._observer) this._observer.disconnect();
      if (this._mutationObserver) this._mutationObserver.disconnect();
      if (this._flushTimer) clearInterval(this._flushTimer);
      this._flush(); // Final flush on teardown
    },
  }));
});
