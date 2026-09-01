/**
 * Public health endpoint for an external uptime pinger (cron-job.org).
 *
 * Resource route — no component, no Shopify authentication. It deliberately
 * sits OUTSIDE the app.* tree: authenticate.admin() would reject an anonymous
 * request, so a health check built on it could never be pinged.
 *
 * ── Why the default response does NOT touch the database ──────────────────
 * The pinger exists to stop Render's free web service idling (~15 minutes to
 * spin down, ~50 seconds to cold start). Any HTTP request achieves that, so
 * this one deliberately does no work.
 *
 * Querying Postgres on every ping would be actively harmful. Neon's free plan
 * allows 100 CU-hours of compute a month and suspends the compute after 5
 * minutes idle; a query every few minutes keeps it awake permanently — about
 * 730 hours a month against a 100-hour allowance, exhausting it in roughly
 * four days, after which Neon suspends the project until the next billing
 * period and the tracker stops working. Neon waking on its own takes about a
 * second, which is invisible beside the Shopify fetch the board does anyway.
 */

import type { LoaderFunctionArgs } from "react-router";

import db from "../db.server";

/** Process start, so the ping can show how long this instance has been up. */
const startedAt = Date.now();

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);

  const body: Record<string, unknown> = {
    status: "ok",
    uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
    timestamp: new Date().toISOString(),
  };

  // Opt-in database probe — for diagnosing by hand, never for the cron.
  // Gated behind a shared secret so an anonymous caller can't spin Neon up at
  // will and burn the compute allowance. Unset HEALTH_TOKEN disables it.
  if (url.searchParams.get("deep") === "1") {
    const token = process.env.HEALTH_TOKEN;
    if (!token || url.searchParams.get("token") !== token) {
      return json({ status: "error", error: "unauthorized" }, 401);
    }
    try {
      await db.$queryRaw`SELECT 1`;
      body.database = "ok";
    } catch (error) {
      console.error("[health] database probe failed:", error);
      body.status = "degraded";
      body.database = "unreachable";
      return json(body, 503);
    }
  }

  // Humans and the deep probe get the JSON. Add ?verbose=1 to read it.
  if (url.searchParams.get("verbose") === "1" || body.database !== undefined) {
    return json(body, 200);
  }

  // The uptime pinger gets a 200 with NO BODY AT ALL.
  //
  // Render's CDN re-chunks every proxied response — verified against two edge
  // nodes — stripping the Content-Length the origin sends. cron-job.org caps
  // response size, has nothing to validate a chunked body against, and aborted
  // this endpoint as "output too large" over 74 bytes. Nothing in application
  // code can stop that re-chunking.
  //
  // But an empty body cannot be chunked: there is nothing to frame. This
  // sidesteps the whole problem rather than fighting the CDN. The diagnostics
  // move to headers, which are unaffected — so `curl -sI` still shows uptime,
  // and ?verbose=1 still returns the full JSON when a human wants it.
  return new Response(null, {
    status: 200,
    headers: {
      "Content-Length": "0",
      "X-Uptime-Seconds": String(body.uptimeSeconds),
      "X-Health-Status": String(body.status),
      "Cache-Control": "no-store, no-cache, must-revalidate, no-transform",
    },
  });
};

function json(body: unknown, status: number): Response {
  const payload = JSON.stringify(body);

  return new Response(payload, {
    status,
    headers: {
      "Content-Type": "application/json",
      // Declare the length explicitly.
      //
      // Without it the response is streamed with Transfer-Encoding: chunked
      // and no declared size. Uptime checkers that enforce a maximum response
      // size have nothing to validate against and abort — cron-job.org failed
      // this endpoint with "output too large" while the body was 75 bytes.
      "Content-Length": String(Buffer.byteLength(payload, "utf8")),
      // no-store/no-cache: never let a proxy answer the pinger from cache, or
      // a cached 200 would report "up" for a service that is down.
      //
      // no-transform is what actually preserves Content-Length above.
      // react-router-serve wraps every response in the `compression`
      // middleware, which drops Content-Length and re-chunks anything it may
      // compress — so setting the header alone did nothing, and the endpoint
      // stayed chunked after the first fix. `compression` explicitly skips
      // responses marked no-transform (RFC 7234 §5.2.2.4), which is the only
      // route-level way to opt out without ejecting from react-router-serve.
      // Compressing 75 bytes is pointless anyway; gzip made it *larger* (89).
      "Cache-Control": "no-store, no-cache, must-revalidate, no-transform",
    },
  });
}
