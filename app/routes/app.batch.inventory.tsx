/**
 * Live stock figures for every variant in a run (resource route — no component).
 *
 * Loaded only when the stock dialog opens, never on page load: the batches
 * page itself must stay free of Shopify calls, and these numbers are only
 * meaningful at the moment somebody is about to write to them.
 *
 * The point of showing them is that the merchant confirms REAL before/after
 * figures rather than trusting the app's arithmetic — the write adds each
 * variant's full planned quantity to on_hand and lets Shopify subtract what is
 * already committed, which is only correct while tracking is on. See
 * app/utils/inventory.server.ts.
 */

import type { LoaderFunctionArgs, ShouldRevalidateFunction } from "react-router";

import { authenticate } from "../shopify.server";
import { BatchError, loadBatch } from "../utils/batch.server";
import { readBatchStock, type BatchStockState } from "../utils/inventory.server";

export const shouldRevalidate: ShouldRevalidateFunction = () => false;

const EMPTY: BatchStockState = { variants: [], locations: [] };

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);

  const batchId = new URL(request.url).searchParams.get("batchId") ?? "";
  if (!batchId) return { ...EMPTY, error: "Unknown run." };

  try {
    // Read the variant list from the run itself rather than the query string:
    // the caller shouldn't be able to ask for stock on variants that aren't
    // in the batch it names.
    const batch = await loadBatch(session.shop, batchId);
    const state = await readBatchStock(
      admin,
      batch.products.flatMap((p) => p.finishes.map((f) => f.variantId))
    );
    return { ...state, error: null as string | null };
  } catch (error) {
    if (error instanceof BatchError) {
      return { ...EMPTY, error: error.message };
    }
    console.error("[batch] inventory loader error:", error);
    return { ...EMPTY, error: "Couldn't read stock from Shopify. Please try again." };
  }
};
