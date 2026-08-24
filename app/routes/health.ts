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

  return json(body, 200);
};

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      // Never let a proxy or CDN answer the pinger from cache: a cached 200
      // would report "up" for a service that is actually down.
      "Cache-Control": "no-store, no-cache, must-revalidate",
    },
  });
}
