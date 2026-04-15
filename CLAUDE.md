# CLAUDE.md — @rmdes/indiekit-endpoint-activitypub

AI agent instructions for working on this codebase. Read this entire file before making any changes.

## What This Is

An Indiekit plugin that adds full ActivityPub federation via [Fedify](https://fedify.dev). It turns an Indiekit-powered IndieWeb site into a fediverse actor — discoverable, followable, and interactive from Mastodon, Misskey, Pixelfed, Lemmy, etc.

**npm:** `@rmdes/indiekit-endpoint-activitypub`
**Version:** See `package.json`
**Node:** >=22
**Module system:** ESM (`"type": "module"`)

## Architecture Overview

Key modules (files self-document via names — read source for full details):

- **`index.js`** — Plugin entry, route registration, lifecycle orchestration
- **`lib/federation-setup.js`** — Fedify instance, dispatchers, keys
- **`lib/federation-bridge.js`** — Express ↔ Fedify bridge (uses `req.originalUrl` — see gotcha #1)
- **`lib/inbox-listeners.js` / `inbox-handlers.js` / `inbox-queue.js`** — Inbound AP activities (async queue)
- **`lib/outbox-failure.js`** — Delivery failure handler (410: full cleanup, 404: strike system)
- **`lib/jf2-to-as2.js`** — JF2 → ActivityStreams conversion (plain JSON + Fedify vocab)
- **`lib/syndicator.js`** — Indiekit syndicator (JF2→AS2, mention resolution, delivery)
- **`lib/item-processing.js`** — Unified pipeline: moderation, quotes, interactions, rendering (see gotcha #23)
- **`lib/mastodon/`** — Mastodon Client API (router, entities, helpers, middleware, routes)
- **`lib/storage/`** — timeline, notifications, moderation, server-blocks, followed-tags, messages
- **`lib/controllers/`** — Admin UI route handlers (dashboard, reader, profile, settings, etc.)
- **`lib/settings.js`** — `getSettings(collections)`: merges `ap_settings` over hardcoded DEFAULTS
- **`views/`** — Nunjucks templates (`activitypub-*.njk`; layout named `ap-reader.njk` — see gotcha #7)
- **`assets/`** — `reader.css`, Alpine.js (`reader-infinite-scroll.js`, `reader-tabs.js`)

## Data Flow

```
Outbound: Indiekit post → syndicator.js syndicate() → jf2ToAS2Activity() → ctx.sendActivity() → follower inboxes
          Broadcast (Update/Delete) → batch-broadcast.js → deduplicated shared inbox delivery
          Delivery failure → outbox-failure.js → 410: full cleanup | 404: strike system → eventual cleanup
Inbound:  Remote inbox POST → Fedify → inbox-listeners.js → ap_inbox_queue → inbox-handlers.js → MongoDB
          Reply forwarding: inbox-listeners.js checks if reply is to our post → ctx.forwardActivity() → follower inboxes
Reader:   Followed account posts → Create inbox → timeline-store → ap_timeline → reader UI
Explore:  Public Mastodon API → fetchMastodonTimeline() → mapMastodonToItem() → explore UI
Mastodon: Client (Phanpy/Elk/Moshidon) → /api/v1/* → ap_timeline + Fedify → JSON responses
          POST /api/v1/statuses → Micropub pipeline → content file → Eleventy rebuild → syndication → AP delivery

All views (reader, explore, tag timeline, hashtag explore, API endpoints) share a single
processing pipeline via item-processing.js:
  items → applyTabFilter() → loadModerationData() → postProcessItems() → render
```

## MongoDB Collections

| Collection | Purpose | Key fields |
|---|---|---|
| `ap_followers` | Accounts following us | `actorUrl` (unique), `inbox`, `sharedInbox`, `source`, `deliveryFailures`, `firstFailureAt`, `lastFailureAt` |
| `ap_following` | Accounts we follow | `actorUrl` (unique), `source`, `acceptedAt` |
| `ap_activities` | Activity log (TTL-indexed) | `direction`, `type`, `actorUrl`, `objectUrl`, `receivedAt` |
| `ap_keys` | Cryptographic key pairs | `type` ("rsa" or "ed25519"), key material |
| `ap_kv` | Fedify KvStore + job state | `_id` (key path), `value` |
| `ap_profile` | Actor profile (single doc) | `name`, `summary`, `icon`, `attachments`, `actorType` |
| `ap_featured` | Pinned posts | `postUrl`, `pinnedAt` |
| `ap_featured_tags` | Featured hashtags | `tag`, `addedAt` |
| `ap_timeline` | Reader timeline items | `uid` (unique), `published`, `author`, `content`, `visibility`, `isContext` |
| `ap_notifications` | Likes, boosts, follows, mentions | `uid` (unique), `type`, `read` |
| `ap_muted` | Muted actors/keywords | `url` or `keyword` |
| `ap_blocked` | Blocked actors | `url` |
| `ap_interactions` | Like/boost tracking per post | `objectUrl`, `type` |
| `ap_messages` | Direct messages | `uid` (unique), `conversationId`, `author`, `content` |
| `ap_followed_tags` | Hashtags we follow | `tag` (unique) |
| `ap_explore_tabs` | Saved explore instances | `instance` (unique), `label` |
| `ap_reports` | Outbound Flag activities | `actorUrl`, `reportedAt` |
| `ap_pending_follows` | Follow requests awaiting approval | `actorUrl` (unique), `receivedAt` |
| `ap_blocked_servers` | Blocked server domains | `hostname` (unique) |
| `ap_key_freshness` | Remote actor key verification timestamps | `actorUrl` (unique), `lastVerifiedAt` |
| `ap_inbox_queue` | Persistent async inbox queue | `activityId`, `status`, `enqueuedAt` |
| `ap_tombstones` | Tombstone records for soft-deleted posts (FEP-4f05) | `url` (unique) |
| `ap_oauth_apps` | Mastodon API client registrations | `clientId` (unique), `clientSecret`, `redirectUris` |
| `ap_oauth_tokens` | OAuth2 authorization codes + access tokens | `code` (unique sparse), `accessToken` (unique sparse) |
| `ap_markers` | Read position markers (Mastodon API) | `userId`, `timeline` |
| `ap_settings` | Admin-configurable plugin settings (single doc) | merged over hardcoded DEFAULTS in `lib/settings.js` |
| `ap_status_edits` | Status edit history snapshots | `statusId`, `content`, `summary`, `editedAt` |
| `ap_filters` | Mastodon v2 keyword filter definitions | `title`, `context`, `filterAction`, `expiresAt` |
| `ap_filter_keywords` | Keywords within filters | `filterId`, `keyword`, `wholeWord` |

## Critical Patterns and Gotchas

### 1. Express ↔ Fedify Bridge (CUSTOM — NOT @fedify/express)

We **cannot** use `@fedify/express`'s `integrateFederation()` because Indiekit mounts plugins at sub-paths. Express strips the mount prefix from `req.url`, breaking Fedify's URI template matching. **Verified in Fedify 2.0**: `@fedify/express` still uses `req.url` (not `req.originalUrl`), so the custom bridge remains necessary. `federation-bridge.js` uses `req.originalUrl` to build the full URL.

The bridge also **reconstructs POST bodies** from `req.body` when Express body parser has already consumed the request stream (checked via `req.readable === false`). Without this, POST handlers in Fedify (e.g. the `@fedify/debugger` login form) receive empty bodies and fail with `"Response body object should not be disturbed or locked"`.

**If you see path-matching issues with Fedify, check that `req.originalUrl` is being used, not `req.url`.**

### 2. Content Negotiation Route — GET Only

The `contentNegotiationRoutes` router is mounted at `/` (root). It MUST only pass `GET`/`HEAD` requests to Fedify. Passing `POST`/`PUT`/`DELETE` would cause `fromExpressRequest()` to consume the body stream, breaking Express body-parsed routes downstream.

### 3. Skip Fedify for Admin Routes

In `routesPublic`, the middleware skips paths starting with `/admin`. Without this, Fedify intercepts admin UI requests and returns 404/406 responses.

### 4. Authenticated Document Loader for Inbox Handlers

All `.getObject()` / `.getActor()` / `.getTarget()` calls in inbox handlers **must** pass an authenticated `DocumentLoader` to sign outbound fetches. Without this, requests to Authorized Fetch servers like hachyderm.io fail with 401.

```javascript
const authLoader = await ctx.getDocumentLoader({ identifier: handle });
const actor = await activity.getActor({ documentLoader: authLoader });
const object = await activity.getObject({ documentLoader: authLoader });
```

The `getAuthLoader` helper in `inbox-listeners.js` wraps this. It's also passed through to `extractObjectData()` and `extractActorInfo()` in `timeline-store.js`.

**Still prefer** `.objectId?.href` and `.actorId?.href` (zero network requests) when you only need the URL. Only use fetching getters when you need the full object, and **always wrap in try-catch**.

### 5. Accept(Follow) Matching — Don't Check Inner Object Type

Fedify often resolves the inner object of `Accept` to a `Person` rather than the `Follow` itself. The Accept handler matches against `ap_following` by actor URL instead of inspecting `inner instanceof Follow`.

### 6. Filter Inbound Likes/Announces to Our Content Only

Check `objectId.startsWith(publicationUrl)` before logging — shared inboxes receive reactions to other people's content.

### 7. Nunjucks Template Name Collisions

Template names resolve across ALL registered plugin view directories. The reader layout is named `ap-reader.njk` to avoid collision with `@rmdes/indiekit-endpoint-microsub`'s `reader.njk`.

**Never name a layout/template with a generic name that another plugin might use.**

### 8. Express 5 — No redirect("back")

Express 5 removed the `"back"` magic keyword from `response.redirect()`. Always use explicit redirect paths.

### 9. Attachment Array Workaround (Mastodon Compatibility)

JSON-LD compaction collapses single-element arrays to plain objects. Mastodon's `update_account_fields` checks `attachment.is_a?(Array)` and silently skips if it's not an array. `sendFedifyResponse()` in `federation-bridge.js` forces `attachment` to always be an array.

### 10. KNOWN ISSUE: PropertyValue Attachment Type Validation

**Upstream issue:** [fedify#629](https://github.com/fedify-dev/fedify/issues/629) — OPEN
`PropertyValue` (schema.org type) is not a valid AS2 Object/Link, so browser.pub rejects `/attachment`. Cannot remove without breaking Mastodon-compatible profile fields.

### 11. Profile Links — Express qs Body Parser Key Mismatch

`express.urlencoded({ extended: true })` strips `[]` from array field names. HTML fields named `link_name[]` arrive as `request.body.link_name`. The profile controller reads `link_name` and `link_value`, NOT `link_name[]`.

### 12. Author Resolution Fallback Chain

`extractObjectData()` in `timeline-store.js` uses a multi-strategy fallback:
1. `object.getAttributedTo()` — async, may fail with Authorized Fetch
2. `options.actorFallback` — the activity's actor (passed from Create handler)
3. `object.attribution` / `object.attributedTo` — plain object properties
4. `object.attributionIds` — non-fetching URL array with username extraction from common patterns (`/@name`, `/users/name`)

### 13. Username Extraction from Actor URLs

Handle multiple URL patterns: `/@username` (Mastodon), `/users/username` (Mastodon, Indiekit), `/ap/users/12345/` (numeric IDs). The regex was previously matching "users" instead of the actual username from `/users/NatalieDavis`.

### 14. Empty Boost Filtering

Lemmy/PieFed send Announce activities where the boosted object resolves to an activity ID instead of a Note/Article. Check `object.content || object.name` before storing.

### 15. Temporal.Instant for Fedify Dates

Fedify uses `@js-temporal/polyfill`. When setting `published`, use `Temporal.Instant.from(isoString)`. When reading Fedify dates, use `String(object.published)` — NOT `new Date(object.published)` (causes `TypeError`).

### 16. LogTape — Configure Once Only

`@logtape/logtape`'s `configure()` can only be called once per process. The `_logtapeConfigured` flag prevents duplicate configuration. When `debugDashboard: true`, LogTape configuration is skipped entirely because `@fedify/debugger` configures its own sink.

### 17. .authorize() Intentionally NOT Chained on Actor Dispatcher

Fedify's `.authorize()` triggers HTTP Signature verification on every GET to the actor endpoint. Servers requiring Authorized Fetch cause infinite loops (401 → retry → 500). Re-enable when Fedify supports authenticated document loading for outgoing fetches.

### 18. Delivery Queue Must Be Started

`federation.startQueue()` MUST be called after setup. Without it, `ctx.sendActivity()` enqueues tasks but they are never processed.

### 19. Shared Key Dispatcher for Shared Inbox

`inboxChain.setSharedKeyDispatcher()` tells Fedify to use our actor's key pair when verifying HTTP Signatures on the shared inbox. Without this, servers like hachyderm.io reject signatures.

### 20. Fedify 2.0 Modular Imports

```javascript
import { createFederation, InProcessMessageQueue } from "@fedify/fedify";
import { exportJwk, generateCryptoKeyPair, importJwk } from "@fedify/fedify/sig";
import { Person, Note, Article, Create, Follow, ... } from "@fedify/fedify/vocab";

// WRONG (Fedify 1.x style):
// import { Person, createFederation, exportJwk } from "@fedify/fedify";
```

### 21. importSpki Removed in Fedify 2.0

Replaced by local `importSpkiPem()` in `federation-setup.js` using `crypto.subtle.importKey("spki", ...)`. Similarly `importPkcs8Pem()` handles PKCS#8 private keys.

### 22. KvStore Requires list() in Fedify 2.0

`list(prefix?)` must return `AsyncIterable<{ key: string[], value: unknown }>`. `MongoKvStore` in `kv-store.js` implements this as an async generator with a regex prefix match on `_id`.

### 23. Unified Item Processing Pipeline

All views displaying timeline items **must** use `lib/item-processing.js`. Never duplicate moderation filtering, quote stripping, interaction map building, or card rendering in individual controllers.

```javascript
const filtered = applyTabFilter(items, tab);
const moderation = await loadModerationData(modCollections);
const { items: processed, interactionMap } = await postProcessItems(filtered, { moderation, interactionsCol });
const html = await renderItemCards(processed, request, { interactionMap, mountPath, csrfToken });
```

Key functions: `postProcessItems()`, `applyModerationFilters()`, `stripQuoteReferences()`, `buildInteractionMap()`, `applyTabFilter()`, `renderItemCards()`, `loadModerationData()`.

### 24. Unified Infinite Scroll Alpine Component

All views with infinite scroll use `apInfiniteScroll` in `assets/reader-infinite-scroll.js`, configured via data attributes:

```html
<div class="ap-load-more"
  data-cursor="{{ cursor }}"
  data-api-url="{{ mountPath }}/admin/reader/api/timeline"
  data-cursor-param="before"
  data-cursor-field="before"
  data-timeline-id="ap-timeline"
  data-extra-params='{{ extraJson }}'
  data-hide-pagination="pagination-id"
  x-data="apInfiniteScroll()"
  x-init="init()">
```

Do not create separate scroll components. The explore view uses `data-cursor-param="max_id"` / `data-cursor-field="maxId"` (Mastodon API conventions).

### 25. Quote Embeds and Enrichment

1. **Ingest:** `extractObjectData()` reads `object.quoteUrl` (handles `as:quoteUrl`, `misskey:_misskey_quote`, `fedibird:quoteUri`)
2. **Enrichment:** `fetchAndStoreQuote()` in `og-unfurl.js` fetches via `ctx.lookupObject()`, stores as `quote` on timeline item
3. **On-demand:** `post-detail.js` fetches quotes for items with `quoteUrl` but no stored `quote` data
4. **Rendering:** `partials/ap-quote-embed.njk`; `stripQuoteReferences()` removes duplicate inline `RE: <link>`

### 26. Async Inbox Processing (v2.14.0+)

`inbox-listeners.js` persists activities to `ap_inbox_queue`; `inbox-handlers.js` processes them asynchronously. Reply forwarding (`ctx.forwardActivity()`) happens synchronously in `inbox-listeners.js` because `forwardActivity()` is only available on `InboxContext`.

### 27. Outbox Delivery Failure Handling (v2.15.0+)

`lib/outbox-failure.js` via `setOutboxPermanentFailureHandler`:
- **410 Gone** → Immediate full cleanup: deletes from `ap_followers`, `ap_timeline` (by `author.url`), `ap_notifications` (by `actorUrl`)
- **404 Not Found** → Strike system: 3 strikes over 7+ days triggers same full cleanup
- **Strike reset** → `resetDeliveryStrikes()` called after every inbound activity (except Block)

### 28. Reply Chain Fetching and Reply Forwarding (v2.15.0+)

- `fetchReplyChain()`: recursively fetches parent posts up to 5 levels via `object.getReplyTarget()`, stored with `isContext: true` using `$setOnInsert` upsert
- Reply forwarding: Create replies to our posts (checked via `inReplyTo.startsWith(publicationUrl)`) addressed to the public collection are forwarded to our followers via `ctx.forwardActivity()`

### 29. Write-Time Visibility Classification (v2.15.0+)

`computeVisibility(object)` classifies at ingest time: `to` includes Public → `"public"`, `cc` includes Public → `"unlisted"`, neither → `"private"`/`"direct"`. Stored as `visibility` on `ap_timeline` docs.

### 30. Server Blocking (v2.14.0+)

`lib/storage/server-blocks.js` manages `ap_blocked_servers`. Inbound activities from blocked domains are rejected in `inbox-listeners.js` before processing.

### 31. Key Freshness Tracking (v2.14.0+)

`touchKeyFreshness()` in `lib/key-refresh.js` is called for every inbound activity, tracking when keys were last verified to skip redundant re-fetches.

### 32. Mastodon Client API — Architecture (v3.0.0+)

Mounted at `/` (domain root) to serve `/api/v1/*`, `/api/v2/*`, `/oauth/*`.

**Key design decisions:**
- **ObjectId-based pagination** — Status IDs are `_id.toString()` (ObjectId hex), NOT published-date cursors. See section 36 for details.
- **Status lookup** — `findTimelineItemById()` does a clean `{ _id: new ObjectId(id) }` lookup — no date parsing
- **Own-post detection** — `setLocalIdentity(publicationUrl, handle)` at init; `serializeAccount()` compares `author.url === publicationUrl`
- **Account enrichment** — Phanpy never calls `/accounts/:id` for timeline authors; `enrichAccountStats()` batch-resolves via Fedify, cached (500 entries, 1h TTL)
- **OAuth for native apps** — Android Custom Tabs block 302 redirects to custom URI schemes; use HTML page with JS `window.location` redirect
- **OAuth token storage** — MUST NOT set `accessToken: null` — use field absence (sparse unique indexes skip absent fields but enforce uniqueness on explicit `null`)
- **Route ordering** — `/accounts/relationships` and `/accounts/familiar_followers` MUST be defined BEFORE `/accounts/:id`
- **Unsigned fallback** — `lookupWithSecurity()` tries authenticated GET first, falls back to unsigned (some servers reject signed GETs with 400)
- **Backfill** — `backfill-timeline.js` converts Micropub posts → `ap_timeline` with content synthesis, hashtag extraction, absolute URL resolution

### 33. Mastodon API — Content Processing (v3.9.4+)

`POST /api/v1/statuses` sends content to Micropub as `{ text, html }` with pre-linkified URLs. `@user@domain` mentions are preserved as plain text for WebFinger resolution by the AP syndicator. No `ap_timeline` entry is created immediately — post appears after the syndication round-trip. `mp-syndicate-to` is set to AP syndicator UID.

### 34. WORKAROUND: Direct Follow for tags.pub (v3.8.4+)

**File:** `lib/direct-follow.js`
**Upstream issue:** [tags.pub#10](https://github.com/social-web-foundation/tags.pub/issues/10) — OPEN
**Remove when:** tags.pub handles `https://w3id.org/identity/v1` context gracefully.

Fedify 2.0 hoists `RsaSignature2017`'s `@context` into the top-level `@context` array. tags.pub's AS2 parser rejects this with `400 Invalid request body`. `lib/direct-follow.js` sends Follow/Undo(Follow) with minimal JSON (standard AS2 context only, draft-cavage HTTP Signatures). `DIRECT_FOLLOW_HOSTS` controls which hostnames use this path. `followActor()`/`unfollowActor()` in `index.js` check `needsDirectFollow(actorUrl)` before sending.

**How to revert:** Remove `needsDirectFollow()` checks from `followActor()`/`unfollowActor()`, remove `_loadRsaPrivateKey()`, remove `direct-follow.js` import and file.

Note: tags.pub does not send `Accept(Follow)` back and `@_followback@tags.pub` does not send Follow activities — outbound delivery from tags.pub appears broken.

### 35. Unverified Delete Activities (Fedify 2.1.0+)

`onUnverifiedActivity()` in `federation-setup.js` handles Delete activities from actors whose keys return 404/410. Checks `reason.type === "keyFetchError"` with status 404/410, cleans up actor data, returns 202.

### 36. FEP-8fcf Collection Synchronization — Outbound Only

`syncCollection: true` on `sendActivity()` attaches `Collection-Synchronization` headers. The **receiving side** (parsing inbound headers, reconciliation) is NOT implemented. Full compliance would require a `/followers-sync` endpoint.

### 37. Mastodon API — Status IDs and Threading (v3.12.0+)

**Status IDs are MongoDB ObjectId hex strings** (`_id.toString()`), NOT published-date cursors. This guarantees uniqueness — the previous cursor-based IDs (`encodeCursor(published)`) caused collisions when multiple posts shared the same second, resulting in `findTimelineItemById` returning wrong documents.

**Key behaviors:**
- `findTimelineItemById` does ObjectId-only lookup — no date parsing, no ambiguity
- `in_reply_to_id` and `in_reply_to_account_id` are batch-resolved via `resolve-reply-ids.js` using parent's `_id.toString()` and `remoteActorId(author.url)`
- Pagination uses ObjectId ordering (`{ _id: -1 }`) — ObjectIds have a 4-byte timestamp prefix so chronological sort works
- `encodeCursor`/`decodeCursor` removed from the API layer entirely

### 38. Mastodon API — Own Post Handling (v3.10.1+)

Own posts are added to `ap_timeline` by the AP syndicator after successful delivery. The syndicator:
- Builds content from JF2 properties via `buildTimelineContent()` (synthesizes content for likes/bookmarks/reposts)
- Linkifies `@mentions` using WebFinger-resolved profile URLs
- Stores resolved mentions with `actorUrl` for proper serialization

**Read-time enrichment by `serializeStatus`:**
- **Permalink** — appended for own posts (detected via `author.url === _localPublicationUrl`). Matches the `🔗` link in federated AS2 content. Done at read time so it survives timeline cleanup/backfill.
- **`@mention` links** — stored at write time on the `ap_timeline` entry with resolved `actorUrl` for deterministic Mastodon account IDs.

### 39. Mastodon API — Access Tokens (v3.12.4+)

**Access tokens do not expire.** They are valid until revoked, matching Mastodon's behavior. The previous 1-hour TTL caused Phanpy/Elk/Moshidon sessions to break silently. Refresh tokens expire after 90 days.

### 40. Mastodon API — Timeline Filtering (v3.12.5+)

**Reply filtering:** Public and hashtag timelines exclude replies (`inReplyTo: { $exists: false }`). Replies only appear in the context/thread view and the home timeline. This matches Mastodon/Pixelfed behavior.

**Home timeline reply visibility (DEFERRED):** Mastodon only shows replies in the home timeline when the user follows BOTH the replier AND the person being replied to. Our home timeline currently shows all replies from followed accounts regardless. Implementing this requires loading the following list and cross-checking each reply's target author — an expensive join per timeline load. Tracked as a future improvement.

**Keyword filters:** The filters CRUD (`GET/POST/PUT/DELETE /api/v2/filters`) stores filters in `ap_filters` with keywords in `ap_filter_keywords`. `apply-filters.js` loads active filters per context, compiles keyword regexes, and applies them after status serialization:
- `filterAction: "hide"` — status removed from response
- `filterAction: "warn"` — status kept with `filtered` array attached (Mastodon v2 format)

### 41. Admin Settings Page (v3.13.0+)

**Route:** `GET/POST {mountPath}/admin/settings`

All configurable values are stored in a single MongoDB document in `ap_settings` collection. `lib/settings.js` provides `getSettings(collections)` which merges DB values over hardcoded defaults — missing keys always fall back.

**Settings by section:**

| Section | Keys |
|---|---|
| Instance & Client API | `instanceLanguages`, `maxCharacters`, `maxMediaAttachments`, `defaultVisibility`, `defaultLanguage` |
| Federation & Delivery | `timelineRetention`, `notificationRetentionDays`, `activityRetentionDays`, `replyChainDepth`, `broadcastBatchSize`, `broadcastBatchDelay`, `parallelWorkers`, `logLevel` |
| Migration | `refollowBatchSize`, `refollowDelay`, `refollowBatchDelay` |
| Security | `refreshTokenTtlDays` |

**How consumers read settings:**
- Mastodon API routes: `req.app.locals.apSettings` (cached 1 minute by `load-settings.js` middleware)
- Non-API code (federation, inbox, batch): `await getSettings(collections)` directly

**Adding a new setting:**
1. Add to `DEFAULTS` in `lib/settings.js`
2. Add parsing in `lib/controllers/settings.js` POST handler
3. Add form field in `views/activitypub-settings.njk`
4. Wire into the consumer file with `settings.newKey` lookup

## Date Handling Convention

**All dates MUST be stored as ISO 8601 strings.** The Nunjucks `| date` filter calls `date-fns parseISO()` which only accepts ISO strings — `Date` objects cause `"dateString.split is not a function"` crashes.

```javascript
// CORRECT
followedAt: new Date().toISOString()
published: String(fedifyObject.published)  // Temporal → string

// WRONG
followedAt: new Date()
published: new Date(fedifyObject.published)
```

## Batch Re-follow State Machine

```
import → refollow:pending → refollow:sent → federation  (Accept received)
import → refollow:pending → refollow:sent → refollow:failed (3 retries exceeded)
```

On restart, `refollow:pending` entries reset to `import` to prevent stale claims.

## Route Structure

Key non-obvious routes (full list in `index.js`):

| Path | Notes |
|---|---|
| `/.well-known/*` | Fedify — WebFinger, NodeInfo |
| `{mount}/users/*`, `{mount}/inbox` | Fedify — actor, inbox, outbox, collections (HTTP Sig) |
| `{mount}/admin/*` | Admin UI — IndieAuth required; Fedify explicitly skipped for these paths (see gotcha #3) |
| `{mount}/api/ap-url?post={url}` | Resolve blog post URL → AP URL (public, no auth) — svemagie fork |
| `{mount}/users/:identifier` | Public profile HTML fallback |
| `/*` (root GET/HEAD only) | Content negotiation for AP clients (see gotcha #2) |
| `/api/v1/*`, `/api/v2/*`, `/oauth/*` | Mastodon Client API (mounted at domain root `/`) |
| `/accounts/relationships`, `/accounts/familiar_followers` | MUST be defined BEFORE `/accounts/:id` |

## Standards Compliance

| FEP | Name | Status | Implementation |
|-----|------|--------|----------------|
| FEP-8b32 | Object Integrity Proofs | Full | Fedify signs all outbound activities with Ed25519 |
| FEP-521a | Multiple key pairs (Multikey) | Full | RSA for HTTP Signatures + Ed25519 for OIP |
| FEP-fe34 | Origin-based security | Full | `lookupWithSecurity()` in `lookup-helpers.js` |
| FEP-8fcf | Collection Sync | Outbound | `syncCollection: true` on `sendActivity()` — receiving side NOT implemented |
| FEP-5feb | Search indexing consent | Full | `indexable: true`, `discoverable: true` on actor in `federation-setup.js` |
| FEP-f1d5 | Enhanced NodeInfo | Full | `setNodeInfoDispatcher()` in `federation-setup.js` |
| FEP-4f05 | Soft delete / Tombstone | Full | `lib/storage/tombstones.js` + 410 in `contentNegotiationRoutes` |
| FEP-3b86 | Activity Intents | Full | WebFinger links + `authorize-interaction.js` intent routing |
| FEP-044f | Quote posts | Full | `quoteUrl` extraction + `ap-quote-embed.njk` rendering |
| FEP-c0e0 | Emoji reactions | Vocab only | Fedify provides `EmojiReact` class, no UI in plugin |
| FEP-5711 | Conversation threads | Vocab only | Fedify provides threading vocab |

## Configuration Options

```javascript
{
  mountPath: "/activitypub",         // URL prefix for all routes
  actor: {
    handle: "rick",                  // Fediverse username
    name: "Ricardo Mendes",          // Display name (seeds profile)
    summary: "",                     // Bio (seeds profile)
    icon: "",                        // Avatar URL (seeds profile)
  },
  checked: true,                     // Syndicator checked by default
  alsoKnownAs: "",                   // Mastodon migration alias
  activityRetentionDays: 90,         // TTL for ap_activities (0 = forever)
  storeRawActivities: false,         // Store full JSON of inbound activities
  redisUrl: "",                      // Redis for delivery queue (empty = in-process)
  parallelWorkers: 5,                // Parallel delivery workers (with Redis)
  actorType: "Person",               // Person | Service | Organization | Group
  logLevel: "warning",               // Fedify log level: debug | info | warning | error | fatal
  timelineRetention: 1000,           // Max timeline items (0 = unlimited)
  notificationRetentionDays: 30,     // Days to keep notifications (0 = forever)
  debugDashboard: false,             // Enable @fedify/debugger dashboard at {mount}/__debug__/
  debugPassword: "",                 // Password for debug dashboard (required if enabled)
}
```

## Startup Gate

This plugin uses `@rmdes/indiekit-startup-gate` to defer background tasks until the host signals readiness (after Eleventy build completes). This prevents resource contention during the build.

**Deferred:** `startBatchRefollow()`, `scheduleCleanup()`, `loadBlockedServersToRedis()`, `scheduleKeyRefresh()`, timeline backfill, `startInboxProcessor()`
**Immediate:** Routes, federation context, inbox HTTP handlers, `runSeparateMentionsMigration()`

See workspace CLAUDE.md for the full startup-gate pattern. Any new background tasks added to this plugin MUST be wrapped in `waitForReady()`. Inbox routes MUST remain immediate — they receive inbound federation traffic regardless of build state.

## Publishing Workflow

1. Bump version in `package.json`
2. Commit and push
3. **STOP** — user must run `npm publish` manually (requires OTP)
4. After publish confirmation, update Dockerfile version in `indiekit-cloudron/`
5. `cloudron build --no-cache && cloudron update --app rmendes.net --no-backup`

## Testing

No automated test suite. Manual testing against real fediverse servers:

```bash
curl -s "https://rmendes.net/.well-known/webfinger?resource=acct:rick@rmendes.net" | jq .
curl -s -H "Accept: application/activity+json" "https://rmendes.net/" | jq .
curl -s "https://rmendes.net/nodeinfo/2.1" | jq .
# Search from Mastodon for @rick@rmendes.net
```

## Form Handling Convention

### Pattern 1: Traditional POST (data mutation forms)

Used for: compose, profile editor, migration alias, notification mark-read/clear.

- Standard `<form method="POST" action="...">`
- CSRF via `<input type="hidden" name="_csrf" value="...">`
- Server processes, then redirects (PRG pattern)
- Feedback via Indiekit's notification banner system
- Uses Indiekit form macros where available

### Pattern 2: Alpine.js Fetch (in-page CRUD operations)

Used for: moderation add/remove keyword/server, tab management, federation actions.

- Alpine.js `@submit.prevent` or `@click` handlers
- CSRF via `X-CSRF-Token` header in `fetch()` call
- Inline error display with `x-show="error"` and `role="alert"`
- Optimistic UI with rollback on failure; no page reload

**Rules:** Do NOT mix patterns on the same page. All forms MUST include CSRF protection. Pattern 1: redirect + banner for feedback. Pattern 2: inline DOM updates.

## CSS Conventions

`assets/reader.css` uses Indiekit's theme custom properties:
- `--color-on-background` (not `--color-text`)
- `--color-on-offset` (not `--color-text-muted`)
- `--border-radius-small` (not `--border-radius`)
- `--color-red45`, `--color-green50`, etc. (not hardcoded hex)

Post types: left border — purple (notes), green (articles), yellow (boosts), primary (replies).

## svemagie Fork — Changes vs Upstream

This fork extends `rmdes/indiekit-endpoint-activitypub`. All changes are for AP protocol compliance and Mastodon interoperability.

1. **`allowPrivateAddress: true`** in `createFederation` (`lib/federation-setup.js`) — allows own-site `lookupObject()` when hostname resolves to a private RFC-1918 address on the LAN.

2. **Canonical `id` on Like activities** (`lib/jf2-to-as2.js`) — derives mount path from actor URL and constructs id at `{publicationUrl}{mountPath}/activities/like/{post-relative-path}` per AP §6.2.1.

3. **Like activity dispatcher** (`lib/federation-setup.js`) — `federation.setObjectDispatcher(Like, ...)` makes Like ids dereferenceable per AP §3.1.

4. **Repost commentary** (`lib/jf2-to-as2.js`) — reposts with `properties.content` fall through to `Create(Note)` instead of bare `Announce`, formatting as `{commentary}<br><br>🔁 <url>`. Pure reposts keep `Announce` behaviour. `jf2ToActivityStreams` also extracts commentary.

5. **`/api/ap-url` public endpoint** (`index.js`) — resolves blog post URL → canonical Fedify-served AP URL for the "Also on Fediverse" widget. For AP-like posts (like-of points to an AP URL), returns `{ apUrl: likeOf }` to open the original remote post.
