/**
 * Shopify inventory reads and the one outward write this app performs.
 *
 * ── Why the write is the FULL planned quantity, not the surplus ───────────
 * The instinct is "add the extra pieces, minus the ones already ordered".
 * Shopify has already done that subtraction. For a tracked variant with seven
 * unfulfilled orders and nothing in stock it holds:
 *
 *     on_hand 0 · committed 7 · available −7
 *
 * Adding the full run of twenty gives:
 *
 *     on_hand 20 · committed 7 · available 13     ← the surplus, exactly
 *
 * Adding only the surplus of thirteen would leave available at 6, and when
 * the seven ship on_hand would fall to 6 while the workshop physically holds
 * thirteen. So the correct delta is the whole run, and the "minus the ordered
 * pieces" happens by itself because Shopify already knows about them.
 *
 * ── Why the adjustment names `available`, not `on_hand` ───────────────────
 * on_hand is NOT a writable ledger state — it is the derived total
 *
 *     on_hand = available + committed + reserved + damaged
 *               + quality_control + safety_stock
 *
 * and inventoryAdjustQuantities rejects it outright ("The specified quantity
 * name is invalid. Valid values are: available, damaged, incoming,
 * quality_control, reserved, safety_stock"). Adjusting `available` by the same
 * delta reaches the identical end state, because on_hand follows the sum:
 * available goes −7 → 13 and on_hand therefore goes 0 → 20.
 *
 * It also happens to be the one name that does NOT require a per-change
 * ledgerDocumentUri, which every other state does.
 *
 * This holds only while inventory tracking is ON for the variant — with
 * tracking off, `committed` is always zero and the subtraction never happens.
 * That is checked per variant before every write rather than assumed, and an
 * untracked variant is SKIPPED with an explanation instead of having its
 * stock quietly inflated by pieces it already owes.
 *
 * ── One run, one adjustment ───────────────────────────────────────────────
 * A run covers many variants, and inventoryAdjustQuantities accepts many
 * changes in a single call. Writing them together means Shopify records one
 * adjustment group for the whole run, so its inventory history reads the way
 * the workshop actually works rather than as a scatter of unrelated edits.
 */

import db from "../db.server";
import { BatchError, loadBatch } from "./batch.server";
import { madeQuantity } from "./batching";
import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";

/** Quantity names read before a write, so the merchant confirms real figures. */
const QUANTITY_NAMES = ["available", "on_hand", "committed"] as const;

/**
 * Variants per inventory query. Each one costs roughly a dozen points with
 * its levels attached, so this keeps a large run well inside Shopify's
 * 1000-point budget instead of gambling on how many variants a run holds.
 */
const VARIANTS_PER_QUERY = 20;

export interface StockLevel {
  locationId: string;
  locationName: string;
  available: number;
  onHand: number;
  committed: number;
}

export interface VariantStock {
  variantId: string;
  inventoryItemId: string | null;
  /** False means Shopify is not counting this variant at all. */
  tracked: boolean;
  levels: StockLevel[];
}

export interface LocationOption {
  locationId: string;
  locationName: string;
  /** How many of the run's variants are actually stocked here. */
  variantsStocked: number;
}

export interface BatchStockState {
  variants: VariantStock[];
  /** Locations that stock at least one variant, best coverage first. */
  locations: LocationOption[];
}

const INVENTORY_QUERY = `
  query BatchInventory($ids: [ID!]!, $names: [String!]!) {
    nodes(ids: $ids) {
      ... on ProductVariant {
        id
        inventoryItem {
          id
          tracked
          inventoryLevels(first: 10) {
            edges {
              node {
                location { id name isActive }
                quantities(names: $names) { name quantity }
              }
            }
          }
        }
      }
    }
  }
`;

const ADJUST_MUTATION = `
  mutation BatchStockAdjust($input: InventoryAdjustQuantitiesInput!) {
    inventoryAdjustQuantities(input: $input) {
      inventoryAdjustmentGroup {
        createdAt
        reason
        changes { name delta quantityAfterChange }
      }
      userErrors { field message }
    }
  }
`;

/**
 * Current stock for every variant in a run, plus the locations that could
 * receive it.
 *
 * Called when the stock dialog opens — never on page load — so the batches
 * page itself stays free of Shopify calls.
 */
export async function readBatchStock(
  admin: AdminApiContext,
  variantIds: string[]
): Promise<BatchStockState> {
  const variants: VariantStock[] = [];

  for (let i = 0; i < variantIds.length; i += VARIANTS_PER_QUERY) {
    const chunk = variantIds.slice(i, i + VARIANTS_PER_QUERY);

    let data: any;
    try {
      const response: any = await admin.graphql(INVENTORY_QUERY, {
        variables: { ids: chunk, names: [...QUANTITY_NAMES] },
      });
      data = await response.json();
    } catch (error) {
      console.error("[batch] inventory read failed:", error);
      throw new BatchError(
        "Couldn't read stock from Shopify. If the app was recently updated it may need to be re-authorised."
      );
    }

    if (Array.isArray(data?.errors) && data.errors.length > 0) {
      console.error("[batch] inventory read errors:", data.errors);
      // Overwhelmingly a missing read_inventory scope, which no amount of
      // retrying fixes — say what to do about it.
      throw new BatchError(
        "Shopify refused the stock request. The app likely needs re-authorising with inventory permissions."
      );
    }

    for (const node of data?.data?.nodes ?? []) {
      if (!node?.id) continue;
      const item = node.inventoryItem;

      const levels: StockLevel[] = [];
      for (const edge of item?.inventoryLevels?.edges ?? []) {
        const level = edge?.node;
        if (!level?.location?.id) continue;
        // An inactive location can't receive stock, so offering it would only
        // produce a failed write later.
        if (level.location.isActive === false) continue;

        const q = new Map<string, number>(
          (level.quantities ?? []).map(
            (x: { name: string; quantity?: number | null }) =>
              [x.name, x.quantity ?? 0] as const
          )
        );
        levels.push({
          locationId: level.location.id,
          locationName: level.location.name ?? "Unnamed location",
          available: q.get("available") ?? 0,
          onHand: q.get("on_hand") ?? 0,
          committed: q.get("committed") ?? 0,
        });
      }

      variants.push({
        variantId: node.id,
        inventoryItemId: item?.id ?? null,
        tracked: Boolean(item?.tracked),
        levels,
      });
    }
  }

  // Rank locations by how much of the run they can actually take, so the
  // default choice is the one that skips the fewest variants.
  const coverage = new Map<string, LocationOption>();
  for (const variant of variants) {
    if (!variant.tracked) continue;
    for (const level of variant.levels) {
      const existing = coverage.get(level.locationId);
      if (existing) existing.variantsStocked += 1;
      else
        coverage.set(level.locationId, {
          locationId: level.locationId,
          locationName: level.locationName,
          variantsStocked: 1,
        });
    }
  }

  return {
    variants,
    locations: [...coverage.values()].sort(
      (a, b) => b.variantsStocked - a.variantsStocked
    ),
  };
}

export interface StockWriteResult {
  /** Variants actually written, with the pieces added to each. */
  written: Array<{ variantId: string; delta: number }>;
  /** Variants left alone, and why — surfaced rather than silently dropped. */
  skipped: Array<{ variantId: string; reason: string }>;
  totalDelta: number;
  locationName: string;
}

/**
 * Add a finished run to Shopify's on-hand count. The only write this app makes
 * to anything outside its own database.
 *
 * Written exactly once per run, enforced by claiming `inventorySyncedAt`
 * BEFORE calling Shopify and releasing it if the call fails. Claiming after a
 * success would leave a window where a double-tap sends two adjustments and
 * only the second is recorded — the stock would be doubled with nothing in
 * the receipt to show it.
 */
export async function writeBatchStock(params: {
  admin: AdminApiContext;
  shop: string;
  batchId: string;
  locationId: string;
}): Promise<StockWriteResult> {
  const { admin, shop, batchId, locationId } = params;

  const batch = await loadBatch(shop, batchId);
  if (batch.status !== "MADE") {
    throw new BatchError(
      "Stock can only be added once the run is finished and marked made."
    );
  }
  if (batch.inventorySyncedAt) {
    throw new BatchError("Stock has already been added to Shopify for this run.");
  }
  if (batch.products.length === 0) {
    throw new BatchError("This run has nothing in it.");
  }

  // Every product's allocation must account for exactly the pieces that
  // survived. An unreconciled product means somebody still has to say which
  // finish absorbs a breakage, and writing stock first would put pieces into
  // Shopify that either don't exist or belong to a finish nobody chose.
  const unreconciled = batch.products.filter((product) => {
    const scrapped = product.scraps.reduce((sum, s) => sum + s.quantity, 0);
    const allocated = product.finishes.reduce((sum, f) => sum + f.quantity, 0);
    return allocated !== madeQuantity(product.plannedQuantity, scrapped);
  });
  if (unreconciled.length > 0) {
    throw new BatchError(
      `Finish the split for ${unreconciled
        .map((p) => p.productTitle)
        .join(", ")} first — the allocation doesn't match what will exist.`
    );
  }

  const finishes = batch.products.flatMap((product) =>
    product.finishes.map((finish) => ({ product, finish }))
  );

  const state = await readBatchStock(
    admin,
    finishes.map(({ finish }) => finish.variantId)
  );
  const stockByVariant = new Map(state.variants.map((v) => [v.variantId, v]));

  const changes: Array<{
    inventoryItemId: string;
    locationId: string;
    delta: number;
  }> = [];
  const written: StockWriteResult["written"] = [];
  const skipped: StockWriteResult["skipped"] = [];
  const locationName =
    state.locations.find((l) => l.locationId === locationId)?.locationName ??
    "the chosen location";

  for (const { product, finish } of finishes) {
    const stock = stockByVariant.get(finish.variantId);
    const label = `${product.productTitle} · ${finish.variantTitle}`;

    // The finish's allocated quantity IS the surviving count for it — scrap
    // was already taken out of the product before the split. Writing the
    // planned figure instead would put broken jewellery into the sellable
    // count, which is the one error here a merchant could not detect from the
    // app: they would simply oversell and find out at packing time.
    const delta = finish.quantity;

    if (!stock || !stock.inventoryItemId) {
      skipped.push({ variantId: finish.variantId, reason: `${label} — not found in Shopify` });
      continue;
    }
    if (!stock.tracked) {
      skipped.push({
        variantId: finish.variantId,
        reason: `${label} — inventory tracking is off`,
      });
      continue;
    }
    if (!stock.levels.some((l) => l.locationId === locationId)) {
      skipped.push({
        variantId: finish.variantId,
        reason: `${label} — not stocked at ${locationName}`,
      });
      continue;
    }
    if (delta <= 0) {
      skipped.push({ variantId: finish.variantId, reason: `${label} — no pieces` });
      continue;
    }

    changes.push({ inventoryItemId: stock.inventoryItemId, locationId, delta });
    written.push({ variantId: finish.variantId, delta });
  }

  if (changes.length === 0) {
    throw new BatchError(
      `Nothing in this run can be added at ${locationName}. ${skipped
        .map((s) => s.reason)
        .join("; ")}.`
    );
  }

  // Claim first — see the doc comment above.
  const claimed = await db.batch.updateMany({
    where: { id: batchId, shop, status: "MADE", inventorySyncedAt: null },
    data: { inventorySyncedAt: new Date() },
  });
  if (claimed.count === 0) {
    throw new BatchError("Stock has already been added to Shopify for this run.");
  }

  try {
    const response: any = await admin.graphql(ADJUST_MUTATION, {
      variables: {
        input: {
          // See the header: on_hand is derived and unwritable; adjusting
          // available by the same delta lands on the same figures.
          name: "available",
          reason: "received",
          // Traceable from Shopify's own inventory history back to this run.
          referenceDocumentUri: `vellismith://batch/${batch.id}`,
          changes,
        },
      },
    });
    const data: any = await response.json();

    if (Array.isArray(data?.errors) && data.errors.length > 0) {
      throw new Error(data.errors.map((e: { message?: string }) => e?.message).join("; "));
    }
    const userErrors = data?.data?.inventoryAdjustQuantities?.userErrors ?? [];
    if (userErrors.length > 0) {
      throw new Error(userErrors.map((e: { message?: string }) => e?.message).join("; "));
    }

    const deltaByVariant = new Map(written.map((w) => [w.variantId, w.delta]));
    await db.$transaction([
      db.batch.update({
        where: { id: batchId },
        data: { inventoryLocationId: locationId, inventoryLocation: locationName },
      }),
      ...finishes
        .filter(({ finish }) => deltaByVariant.has(finish.variantId))
        .map(({ finish }) =>
          db.batchFinish.update({
            where: { id: finish.id },
            // The receipt records what was actually added, so a later reader
            // can reconcile it against Shopify.
            data: { inventoryDelta: deltaByVariant.get(finish.variantId) },
          })
        ),
    ]);

    const totalDelta = written.reduce((sum, w) => sum + w.delta, 0);
    console.log(
      `[batch] stock written · "${batch.name}" · +${totalDelta} available across ` +
        `${written.length} variant(s) at ${locationName}` +
        (skipped.length > 0 ? ` · ${skipped.length} skipped` : "")
    );

    return { written, skipped, totalDelta, locationName };
  } catch (error) {
    // Release the claim so the merchant can retry. Nothing reached Shopify on
    // this path, so leaving the run marked synced would strand real pieces
    // outside the stock count with no way to add them.
    await db.batch.updateMany({
      where: { id: batchId, shop },
      data: { inventorySyncedAt: null },
    });
    console.error("[batch] stock write failed:", error);
    throw new BatchError(
      `Shopify rejected the stock update: ${(error as Error).message}`
    );
  }
}
