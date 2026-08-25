/**
 * Board data endpoint (resource route — no component).
 *
 * The tracker's data costs a full two-phase sweep of every unfulfilled order,
 * which on a busy store takes many seconds. Doing that in the Track page's own
 * loader blocked the whole navigation: React Router keeps the PREVIOUS route
 * on screen until the next one's loader resolves, so clicking Track moved the
 * URL but left the old page rendered, looking like a dead link.
 *
 * Keeping it here instead lets /app/track render instantly and pull its data
 * afterwards via fetcher.load(), with a skeleton in the meantime.
 */

import type { LoaderFunctionArgs, ShouldRevalidateFunction } from "react-router";

import { authenticate } from "../shopify.server";
import { getBoard, type TrackedLine } from "../utils/tracker.server";

/**
 * Don't re-run this sweep after our own writes.
 *
 * React Router revalidates fetcher.load data once an action completes, which
 * would drag the full Shopify fetch back onto every status tap. A status
 * change only touches OUR database — Shopify's orders are unchanged — and the
 * board already applies the change optimistically, so there is nothing to
 * re-read. The Refresh button reloads this route explicitly.
 */
export const shouldRevalidate: ShouldRevalidateFunction = () => false;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);

  // ?force=1 comes from the board's Refresh button and bypasses the cache.
  const force = new URL(request.url).searchParams.get("force") === "1";

  try {
    const { lines, fetchedAt, cached } = await getBoard(admin, session.shop, {
      force,
    });
    return { lines, fetchedAt, cached, error: null as string | null };
  } catch (error) {
    console.error("[track] board loader error:", error);
    return {
      lines: [] as TrackedLine[],
      fetchedAt: null as string | null,
      cached: false,
      error: "Couldn't load orders from Shopify. Please try again.",
    };
  }
};
