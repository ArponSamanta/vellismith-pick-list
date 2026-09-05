/**
 * Batches page data endpoint (resource route — no component).
 *
 * Same reasoning as app.track.board: the page's data depends on the full
 * outstanding-order list, and doing that work in the page's own loader would
 * block the navigation and leave the previous screen up, looking like a dead
 * nav link. The page renders instantly and pulls this afterwards.
 *
 * While the tracker's order-line cache is warm this costs no Shopify request
 * at all — it reuses exactly the same cached list the Track board reads.
 */

import type { LoaderFunctionArgs, ShouldRevalidateFunction } from "react-router";

import { authenticate } from "../shopify.server";
import { getBatchPage, type BatchPageData } from "../utils/batch.server";

/**
 * Don't re-run this after our own writes.
 *
 * React Router revalidates fetcher.load data once an action completes. Batch
 * actions are followed by an explicit reload of this route when their result
 * actually changes what is on screen, so an automatic revalidation would only
 * duplicate that — and on a cold cache it would drag a full Shopify sweep onto
 * every tap.
 */
export const shouldRevalidate: ShouldRevalidateFunction = () => false;

/**
 * `fetchedAt` is null here, not an epoch timestamp.
 *
 * A placeholder date is not a harmless default: the page renders it as "orders
 * 496761 h ago", which reads as a bizarre data problem and buries the actual
 * error underneath it. Null means "we never got as far as reading orders", and
 * the page simply omits the freshness line.
 */
const EMPTY: Omit<BatchPageData, "fetchedAt"> & { fetchedAt: string | null } = {
  batches: [],
  candidates: [],
  suggestions: [],
  readyToShipPieces: 0,
  // Not "Run 01": on an error path we never read the existing runs, and
  // guessing a number that is probably already taken is worse than an empty
  // field the server will fill in correctly at save time.
  nextRunName: "",
  fetchedAt: null,
  cached: false,
  canWriteInventory: false,
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);

  // ?force=1 comes from the page's Refresh button and bypasses the cache.
  const force = new URL(request.url).searchParams.get("force") === "1";

  try {
    const data = await getBatchPage(admin, session.shop, { force });
    return { ...data, fetchedAt: data.fetchedAt as string | null, error: null as string | null };
  } catch (error) {
    console.error("[batch] data loader error:", error);
    // Deliberately not "couldn't reach Shopify": this path also catches a
    // database failure, and naming the wrong culprit sends the reader looking
    // in the wrong place. The console line above carries the real cause.
    return { ...EMPTY, error: "Couldn't load this page. Please try again." };
  }
};
