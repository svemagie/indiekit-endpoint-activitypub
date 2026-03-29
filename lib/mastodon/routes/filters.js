/**
 * Filter endpoints for Mastodon Client API v2.
 */
import express from "express";
import { ObjectId } from "mongodb";
import { tokenRequired } from "../middleware/token-required.js";
import { scopeRequired } from "../middleware/scope-required.js";

const router = express.Router(); // eslint-disable-line new-cap

/**
 * Serialize a filter document with its keywords.
 */
function serializeFilter(filter, keywords = []) {
  return {
    id: filter._id.toString(),
    title: filter.title || "",
    context: filter.context || [],
    filter_action: filter.filterAction || "warn",
    expires_at: filter.expiresAt || null,
    keywords: keywords.map((kw) => ({
      id: kw._id.toString(),
      keyword: kw.keyword,
      whole_word: kw.wholeWord ?? true,
    })),
    statuses: [],
  };
}

// ─── GET /api/v2/filters ────────────────────────────────────────────────────

router.get("/api/v2/filters", tokenRequired, scopeRequired("read", "read:filters"), async (req, res, next) => {
  try {
    const collections = req.app.locals.mastodonCollections;
    if (!collections.ap_filters) return res.json([]);

    const filters = await collections.ap_filters.find({}).toArray();
    const result = [];

    for (const filter of filters) {
      const keywords = collections.ap_filter_keywords
        ? await collections.ap_filter_keywords
            .find({ filterId: filter._id })
            .toArray()
        : [];
      result.push(serializeFilter(filter, keywords));
    }

    res.json(result);
  } catch (error) {
    next(error);
  }
});

// ─── POST /api/v2/filters ───────────────────────────────────────────────────

router.post("/api/v2/filters", tokenRequired, scopeRequired("write", "write:filters"), async (req, res, next) => {
  try {
    const collections = req.app.locals.mastodonCollections;
    if (!collections.ap_filters) {
      return res.status(500).json({ error: "Filters not available" });
    }

    const {
      title,
      context,
      filter_action: filterAction = "warn",
      expires_in: expiresIn,
      keywords_attributes: keywordsAttributes,
    } = req.body;

    if (!title) {
      return res.status(422).json({ error: "title is required" });
    }

    const expiresAt = expiresIn
      ? new Date(Date.now() + Number.parseInt(expiresIn, 10) * 1000).toISOString()
      : null;

    const filterDoc = {
      title,
      context: Array.isArray(context) ? context : [context].filter(Boolean),
      filterAction,
      expiresAt,
      createdAt: new Date().toISOString(),
    };

    const result = await collections.ap_filters.insertOne(filterDoc);
    filterDoc._id = result.insertedId;

    // Insert keywords if provided
    const keywords = [];
    if (keywordsAttributes && collections.ap_filter_keywords) {
      const attrs = Array.isArray(keywordsAttributes)
        ? keywordsAttributes
        : Object.values(keywordsAttributes);
      for (const attr of attrs) {
        if (attr.keyword) {
          const kwDoc = {
            filterId: filterDoc._id,
            keyword: attr.keyword,
            wholeWord: attr.whole_word !== "false" && attr.whole_word !== false,
          };
          const kwResult = await collections.ap_filter_keywords.insertOne(kwDoc);
          kwDoc._id = kwResult.insertedId;
          keywords.push(kwDoc);
        }
      }
    }

    res.json(serializeFilter(filterDoc, keywords));
  } catch (error) {
    next(error);
  }
});

// ─── GET /api/v2/filters/:id ────────────────────────────────────────────────

router.get("/api/v2/filters/:id", tokenRequired, scopeRequired("read", "read:filters"), async (req, res, next) => {
  try {
    const collections = req.app.locals.mastodonCollections;
    let filter;
    try {
      filter = await collections.ap_filters?.findOne({
        _id: new ObjectId(req.params.id),
      });
    } catch { /* invalid ObjectId */ }

    if (!filter) {
      return res.status(404).json({ error: "Record not found" });
    }

    const keywords = collections.ap_filter_keywords
      ? await collections.ap_filter_keywords
          .find({ filterId: filter._id })
          .toArray()
      : [];

    res.json(serializeFilter(filter, keywords));
  } catch (error) {
    next(error);
  }
});

// ─── PUT /api/v2/filters/:id ────────────────────────────────────────────────

router.put("/api/v2/filters/:id", tokenRequired, scopeRequired("write", "write:filters"), async (req, res, next) => {
  try {
    const collections = req.app.locals.mastodonCollections;
    let filter;
    try {
      filter = await collections.ap_filters?.findOne({
        _id: new ObjectId(req.params.id),
      });
    } catch { /* invalid ObjectId */ }

    if (!filter) {
      return res.status(404).json({ error: "Record not found" });
    }

    const update = {};
    if (req.body.title !== undefined) update.title = req.body.title;
    if (req.body.context !== undefined) {
      update.context = Array.isArray(req.body.context)
        ? req.body.context
        : [req.body.context].filter(Boolean);
    }
    if (req.body.filter_action !== undefined) update.filterAction = req.body.filter_action;
    if (req.body.expires_in !== undefined) {
      update.expiresAt = req.body.expires_in
        ? new Date(Date.now() + Number.parseInt(req.body.expires_in, 10) * 1000).toISOString()
        : null;
    }

    if (Object.keys(update).length > 0) {
      await collections.ap_filters.updateOne(
        { _id: filter._id },
        { $set: update },
      );
      Object.assign(filter, update);
    }

    const keywords = collections.ap_filter_keywords
      ? await collections.ap_filter_keywords
          .find({ filterId: filter._id })
          .toArray()
      : [];

    res.json(serializeFilter(filter, keywords));
  } catch (error) {
    next(error);
  }
});

// ─── DELETE /api/v2/filters/:id ─────────────────────────────────────────────

router.delete("/api/v2/filters/:id", tokenRequired, scopeRequired("write", "write:filters"), async (req, res, next) => {
  try {
    const collections = req.app.locals.mastodonCollections;
    let filterId;
    try {
      filterId = new ObjectId(req.params.id);
    } catch {
      return res.status(404).json({ error: "Record not found" });
    }

    await collections.ap_filters?.deleteOne({ _id: filterId });
    await collections.ap_filter_keywords?.deleteMany({ filterId });

    res.json({});
  } catch (error) {
    next(error);
  }
});

export default router;
