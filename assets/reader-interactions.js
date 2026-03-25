/**
 * Card interaction Alpine.js component.
 * Handles like, boost, and save-for-later actions with optimistic UI and
 * rollback on failure.
 *
 * Configured via data-* attributes on the container element (the <footer>):
 *   data-item-uid="..."        canonical AP UID used for like/boost API calls
 *   data-item-url="..."        display URL used for saveLater and links
 *   data-csrf-token="..."
 *   data-mount-path="..."
 *   data-liked="true|false"
 *   data-boosted="true|false"
 *   data-like-count="N"        omit or empty string for null
 *   data-boost-count="N"       omit or empty string for null
 */
document.addEventListener("alpine:init", () => {
  Alpine.data("apCardInteraction", () => ({
    liked: false,
    boosted: false,
    saved: false,
    loading: false,
    error: "",
    likeCount: null,
    boostCount: null,

    init() {
      this.liked = this.$el.dataset.liked === "true";
      this.boosted = this.$el.dataset.boosted === "true";
      const lc = this.$el.dataset.likeCount;
      const bc = this.$el.dataset.boostCount;
      this.likeCount = lc != null && lc !== "" ? Number(lc) : null;
      this.boostCount = bc != null && bc !== "" ? Number(bc) : null;
    },

    async saveLater() {
      if (this.saved) return;
      const el = this.$el;
      const itemUrl = el.dataset.itemUrl;
      try {
        const res = await fetch("/readlater/save", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            url: itemUrl,
            title:
              el.closest("article")?.querySelector("p")?.textContent?.substring(0, 80) ||
              itemUrl,
            source: "activitypub",
          }),
          credentials: "same-origin",
        });
        if (res.ok) this.saved = true;
        else this.error = "Failed to save";
      } catch (e) {
        this.error = e.message;
      }
      if (this.error) setTimeout(() => (this.error = ""), 3000);
    },

    async interact(action) {
      if (this.loading) return;
      this.loading = true;
      this.error = "";
      const el = this.$el;
      const itemUid = el.dataset.itemUid;
      const csrfToken = el.dataset.csrfToken;
      const basePath = el.dataset.mountPath;
      const prev = {
        liked: this.liked,
        boosted: this.boosted,
        boostCount: this.boostCount,
        likeCount: this.likeCount,
      };
      if (action === "like") {
        this.liked = true;
        if (this.likeCount !== null) this.likeCount++;
      } else if (action === "unlike") {
        this.liked = false;
        if (this.likeCount !== null && this.likeCount > 0) this.likeCount--;
      } else if (action === "boost") {
        this.boosted = true;
        if (this.boostCount !== null) this.boostCount++;
      } else if (action === "unboost") {
        this.boosted = false;
        if (this.boostCount !== null && this.boostCount > 0) this.boostCount--;
      }
      try {
        const res = await fetch(basePath + "/admin/reader/" + action, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-CSRF-Token": csrfToken,
          },
          body: JSON.stringify({ url: itemUid }),
        });
        const data = await res.json();
        if (!data.success) {
          this.liked = prev.liked;
          this.boosted = prev.boosted;
          this.boostCount = prev.boostCount;
          this.likeCount = prev.likeCount;
          this.error = data.error || "Failed";
        }
      } catch (e) {
        this.liked = prev.liked;
        this.boosted = prev.boosted;
        this.boostCount = prev.boostCount;
        this.likeCount = prev.likeCount;
        this.error = e.message;
      }
      this.loading = false;
      if (this.error) setTimeout(() => (this.error = ""), 3000);
    },
  }));
});
