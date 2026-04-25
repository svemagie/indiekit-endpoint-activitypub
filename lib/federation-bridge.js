/**
 * Express ↔ Fedify bridge.
 *
 * Converts Express requests to standard Request objects and delegates
 * to federation.fetch(). We can't use @fedify/express's integrateFederation()
 * because Indiekit plugins mount routes at a sub-path (e.g. /activitypub),
 * which causes req.url to lose the mount prefix. Instead, we use
 * req.originalUrl to preserve the full path that Fedify's URI templates expect.
 */

import { Readable } from "node:stream";
import { Buffer } from "node:buffer";

/**
 * Convert an Express request to a standard Request with the full URL.
 *
 * @param {import("express").Request} req - Express request
 * @returns {Request} Standard Request object
 */
export function fromExpressRequest(req, baseUrl) { // ap-base-url patch
  const url = baseUrl
    ? `${baseUrl.replace(/\/$/, "")}${req.originalUrl}` // ap-base-url patch
    : `${req.protocol}://${req.get("host")}${req.originalUrl}`;
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) {
      for (const v of value) headers.append(key, v);
    } else if (typeof value === "string") {
      headers.append(key, value);
    }
  }

  // Normalise "host" to the public hostname so Fedify's HTTP Signature
  // verifier reconstructs the same signed-string the remote server created.
  // Without this, nginx may forward an internal Host (e.g. "10.100.0.20")
  // which doesn't match what the sender signed, causing every inbox POST
  // to fail with "Failed to verify the request's HTTP Signatures".
  if (baseUrl) {
    try {
      const _canonicalHost = new URL(baseUrl).host; // e.g. "blog.giersig.eu"
      headers.set("host", _canonicalHost);
    } catch { /* invalid baseUrl — leave header as-is */ }
  }

  let body;
  if (req.method === "GET" || req.method === "HEAD") {
    body = undefined;
  } else if (!req.readable && req.body) {
    // Express body parser already consumed the stream — reconstruct
    // so downstream handlers (e.g. @fedify/debugger login) can read it.
    const ct = req.headers["content-type"] || "";
    // Handle activity+json and ld+json bodies (PeerTube, Mastodon, etc.).
    // Use original raw bytes when available (set by the buffer guard below)
    // so Fedify's HTTP Signature Digest check passes.
    if (ct.includes("application/json") || ct.includes("activity+json") || ct.includes("ld+json")) {
      body = req._rawBody || JSON.stringify(req.body);
    } else if (ct.includes("application/x-www-form-urlencoded")) {
      body = new URLSearchParams(req.body).toString();
    } else {
      body = undefined;
    }
  } else {
    body = Readable.toWeb(req);
  }

  return new Request(url, {
    method: req.method,
    headers,
    duplex: "half",
    body,
  });
}

/**
 * Send a standard Response back through Express.
 *
 * @param {import("express").Response} res - Express response
 * @param {Response} response - Standard Response from federation.fetch()
 * @param {Request} [request] - Original request (for targeted patching)
 */
async function sendFedifyResponse(res, response, request) {
  res.status(response.status);
  response.headers.forEach((value, key) => {
    res.setHeader(key, value);
  });

  if (!response.body || response.bodyUsed) {
    res.end();
    return;
  }

  // WORKAROUND: JSON-LD compaction collapses single-element arrays to a
  // plain object. Mastodon's update_account_fields checks
  // `attachment.is_a?(Array)` and skips if it's not an array, so
  // profile links/PropertyValues are silently ignored.
  // Force `attachment` to always be an array for Mastodon compatibility.
  const contentType = response.headers.get("content-type") || "";
  const isActorJson =
    contentType.includes("activity+json") ||
    contentType.includes("ld+json");

  if (isActorJson) {
    const body = await response.text();
    try {
      const json = JSON.parse(body);
      if (json.attachment && !Array.isArray(json.attachment)) {
        json.attachment = [json.attachment];
      }
      const patched = JSON.stringify(json);
      res.setHeader("content-length", Buffer.byteLength(patched));
      res.end(patched);
    } catch {
      // Not valid JSON — send as-is
      res.end(body);
    }
    return;
  }

  const reader = response.body.getReader();
  await new Promise((resolve) => {
    function read({ done, value }) {
      if (done) {
        reader.releaseLock();
        resolve();
        return;
      }
      res.write(Buffer.from(value));
      reader.read().then(read);
    }
    reader.read().then(read);
  });
  res.end();
}

/**
 * Create Express middleware that delegates to Fedify's federation.fetch().
 *
 * On 404 (Fedify didn't match), calls next().
 * On 406 (not acceptable), calls next() so Express can try other handlers.
 * Otherwise, sends the Fedify response directly.
 *
 * @param {import("@fedify/fedify").Federation} federation
 * @param {Function} contextDataFactory - (req) => contextData
 * @returns {import("express").RequestHandler}
 */
export function createFedifyMiddleware(federation, contextDataFactory, baseUrl) { // ap-base-url patch
  return async (req, res, next) => {
    try {
      // Buffer application/activity+json and ld+json request bodies ourselves —
      // Express's JSON body parser only handles application/json, so req.body
      // is otherwise undefined for AP inbox POSTs. We need the body to:
      //   1. Detect and short-circuit PeerTube View (WatchAction) activities
      //      before Fedify's JSON-LD parser chokes on Schema.org extensions.
      //   2. Preserve original bytes in req._rawBody so fromExpressRequest()
      //      can pass them to Fedify verbatim, keeping HTTP Signature Digest
      //      verification intact (JSON.stringify reorders keys, breaking it).
      const _apct = req.headers["content-type"] || "";
      if (
        req.method === "POST" &&
        !req.body &&
        req.readable &&
        (_apct.includes("activity+json") || _apct.includes("ld+json"))
      ) {
        const _chunks = [];
        for await (const _chunk of req) {
          _chunks.push(Buffer.isBuffer(_chunk) ? _chunk : Buffer.from(_chunk));
        }
        const _raw = Buffer.concat(_chunks);
        req._rawBody = _raw; // preserve for Fedify Digest check
        try {
          req.body = JSON.parse(_raw.toString("utf8"));
        } catch {
          req.body = {};
        }
      }
      // Silently accept PeerTube View (WatchAction) — return 200 to prevent
      // retries. Fedify's vocab parser throws on PeerTube's Schema.org
      // extensions before any inbox handler is reached.
      if (req.method === "POST" && req.body?.type === "View") {
        return res.status(200).end();
      }

      const request = fromExpressRequest(req, baseUrl); // ap-base-url patch
      const contextData = await Promise.resolve(contextDataFactory(req));

      let notFound = false;
      let notAcceptable = false;

      const response = await federation.fetch(request, {
        contextData,
        onNotFound: () => {
          notFound = true;
          return new Response("Not found", { status: 404 });
        },
        onNotAcceptable: () => {
          notAcceptable = true;
          return new Response("Not acceptable", {
            status: 406,
            headers: { "Content-Type": "text/plain", Vary: "Accept" },
          });
        },
      });

      if (notFound || notAcceptable) {
        return next();
      }

      await sendFedifyResponse(res, response);
    } catch (error) {
      next(error);
    }
  };
}
