/**
 * ActivityPub syndicator — delivers posts to followers via Fedify.
 * @module syndicator
 */
import {
  jf2ToAS2Activity,
  parseMentions,
} from "./jf2-to-as2.js";
import { lookupWithSecurity } from "./lookup-helpers.js";
import { logActivity } from "./activity-log.js";
import { addTimelineItem } from "./storage/timeline.js";

/**
 * Create the ActivityPub syndicator object.
 * @param {object} plugin - ActivityPubEndpoint instance
 * @returns {object} Syndicator compatible with Indiekit's syndicator API
 */
export function createSyndicator(plugin) {
  return {
    name: "ActivityPub syndicator",
    options: { checked: plugin.options.checked },

    get info() {
      const hostname = plugin._publicationUrl
        ? new URL(plugin._publicationUrl).hostname
        : "example.com";
      return {
        checked: plugin.options.checked,
        name: `@${plugin.options.actor.handle}@${hostname}`,
        uid: plugin._publicationUrl || "https://example.com/",
        service: {
          name: "ActivityPub (Fediverse)",
          photo: "/assets/@rmdes-indiekit-endpoint-activitypub/icon.svg",
          url: plugin._publicationUrl || "https://example.com/",
        },
      };
    },

    async syndicate(properties) {
      if (!plugin._federation) {
        return undefined;
      }

      try {
        const actorUrl = plugin._getActorUrl();
        const handle = plugin.options.actor.handle;

        const ctx = plugin._federation.createContext(
          new URL(plugin._publicationUrl),
          { handle, publicationUrl: plugin._publicationUrl },
        );

        // For replies, resolve the original post author for proper
        // addressing (CC) and direct inbox delivery
        let replyToActor = null;
        if (properties["in-reply-to"]) {
          try {
            const remoteObject = await lookupWithSecurity(ctx,
              new URL(properties["in-reply-to"]),
            );
            if (remoteObject && typeof remoteObject.getAttributedTo === "function") {
              const author = await remoteObject.getAttributedTo();
              const authorActor = Array.isArray(author) ? author[0] : author;
              if (authorActor?.id) {
                replyToActor = {
                  url: authorActor.id.href,
                  handle: authorActor.preferredUsername || null,
                  recipient: authorActor,
                };
                console.info(
                  `[ActivityPub] Reply to ${properties["in-reply-to"]} — resolved author: ${replyToActor.url}`,
                );
              }
            }
          } catch (error) {
            console.warn(
              `[ActivityPub] Could not resolve reply-to author for ${properties["in-reply-to"]}: ${error.message}`,
            );
          }
        }

        // Resolve @user@domain mentions in content via WebFinger
        const contentText = properties.content?.html || properties.content || "";
        const mentionHandles = parseMentions(contentText);
        const resolvedMentions = [];
        const mentionRecipients = [];

        for (const { handle } of mentionHandles) {
          try {
            const mentionedActor = await lookupWithSecurity(ctx,
              new URL(`acct:${handle}`),
            );
            if (mentionedActor?.id) {
              resolvedMentions.push({
                handle,
                actorUrl: mentionedActor.id.href,
                profileUrl: mentionedActor.url?.href || null,
              });
              mentionRecipients.push({
                handle,
                actorUrl: mentionedActor.id.href,
                actor: mentionedActor,
              });
              console.info(
                `[ActivityPub] Resolved mention @${handle} → ${mentionedActor.id.href}`,
              );
            }
          } catch (error) {
            console.warn(
              `[ActivityPub] Could not resolve mention @${handle}: ${error.message}`,
            );
            // Still add with no actorUrl so it gets a fallback link
            resolvedMentions.push({ handle, actorUrl: null });
          }
        }

        const activity = await jf2ToAS2Activity(
          properties,
          actorUrl,
          plugin._publicationUrl,
          {
            replyToActorUrl: replyToActor?.url,
            replyToActorHandle: replyToActor?.handle,
            visibility: plugin.options.defaultVisibility,
            mentions: resolvedMentions,
          },
        );

        if (!activity) {
          await logActivity(plugin._collections.ap_activities, {
            direction: "outbound",
            type: "Syndicate",
            actorUrl: plugin._publicationUrl,
            objectUrl: properties.url,
            summary: `Syndication skipped: could not convert post to AS2`,
          });
          return undefined;
        }

        // Count followers for logging
        const followerCount =
          await plugin._collections.ap_followers.countDocuments();

        console.info(
          `[ActivityPub] Sending ${activity.constructor?.name || "activity"} for ${properties.url} to ${followerCount} followers`,
        );

        // Send to followers via shared inboxes with collection sync (FEP-8fcf)
        await ctx.sendActivity(
          { identifier: handle },
          "followers",
          activity,
          {
            preferSharedInbox: true,
            syncCollection: true,
            orderingKey: properties.url,
          },
        );

        // For replies, also deliver to the original post author's inbox
        // so their server can thread the reply under the original post
        if (replyToActor?.recipient) {
          try {
            await ctx.sendActivity(
              { identifier: handle },
              replyToActor.recipient,
              activity,
              { orderingKey: properties.url },
            );
            console.info(
              `[ActivityPub] Reply delivered to author: ${replyToActor.url}`,
            );
          } catch (error) {
            console.warn(
              `[ActivityPub] Failed to deliver reply to ${replyToActor.url}: ${error.message}`,
            );
          }
        }

        // Deliver to mentioned actors' inboxes (skip reply-to author, already delivered above)
        for (const { handle: mHandle, actorUrl: mUrl, actor: mActor } of mentionRecipients) {
          if (replyToActor?.url === mUrl) continue;
          try {
            await ctx.sendActivity(
              { identifier: handle },
              mActor,
              activity,
              { orderingKey: properties.url },
            );
            console.info(
              `[ActivityPub] Mention delivered to @${mHandle}: ${mUrl}`,
            );
          } catch (error) {
            console.warn(
              `[ActivityPub] Failed to deliver mention to @${mHandle}: ${error.message}`,
            );
          }
        }

        // Determine activity type name
        const typeName =
          activity.constructor?.name || "Create";
        const replyNote = replyToActor
          ? ` (reply to ${replyToActor.url})`
          : "";
        const mentionNote = mentionRecipients.length > 0
          ? ` (mentions: ${mentionRecipients.map(m => `@${m.handle}`).join(", ")})`
          : "";

        await logActivity(plugin._collections.ap_activities, {
          direction: "outbound",
          type: typeName,
          actorUrl: plugin._publicationUrl,
          objectUrl: properties.url,
          targetUrl: properties["in-reply-to"] || undefined,
          summary: `Sent ${typeName} for ${properties.url} to ${followerCount} followers${replyNote}${mentionNote}`,
        });

        console.info(
          `[ActivityPub] Syndication queued: ${typeName} for ${properties.url}${replyNote}`,
        );

        // Mirror own Micropub-created posts into ap_timeline so the Mastodon
        // Client API (context, statuses, etc.) can find them by ID.
        if (typeName === "Create" && properties.url) {
          try {
            const rawHtml = properties.content?.html || (typeof properties.content === "string" ? properties.content : "") || "";
            const now = new Date().toISOString();
            const postType = properties["post-type"] || "note";
            const asArray = (v) => Array.isArray(v) ? v : v ? [v] : [];
            await addTimelineItem(plugin._collections, {
              uid: properties.url,
              url: properties.url,
              type: postType,
              content: { html: rawHtml, text: rawHtml.replace(/<[^>]*>/g, "") },
              summary: properties["content-warning"] || properties.summary || "",
              sensitive: !!(properties.sensitive || properties["content-warning"]),
              visibility: properties.visibility || plugin.options.defaultVisibility || "public",
              language: properties.lang || properties.language || null,
              inReplyTo: properties["in-reply-to"] || null,
              published: properties.published || now,
              createdAt: now,
              author: {
                name: plugin.options.actor.name || handle,
                url: actorUrl,
                photo: plugin.options.actor.icon || "",
                handle: `@${handle}`,
                emojis: [],
                bot: false,
              },
              photo: asArray(properties.photo),
              video: asArray(properties.video),
              audio: asArray(properties.audio),
              category: asArray(properties.category),
              counts: { replies: 0, boosts: 0, likes: 0 },
              linkPreviews: [],
              mentions: [],
              emojis: [],
            });
          } catch (timelineError) {
            console.warn("[ActivityPub] Failed to mirror syndicated post to ap_timeline:", timelineError.message);
          }
        }

        return properties.url || undefined;
      } catch (error) {
        console.error("[ActivityPub] Syndication failed:", error.message);
        await logActivity(plugin._collections.ap_activities, {
          direction: "outbound",
          type: "Syndicate",
          actorUrl: plugin._publicationUrl,
          objectUrl: properties.url,
          summary: `Syndication failed: ${error.message}`,
        }).catch(() => {});
        return undefined;
      }
    },

    delete: async (url) => plugin.delete(url),
    update: async (properties) => plugin.update(properties),
  };
}
