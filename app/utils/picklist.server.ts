import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";

// ─── Public types ─────────────────────────────────────────────────────────────

export type SortBy =
  | "alpha"
  | "old-to-new"
  | "new-to-old"
  | "qty-high-to-low"
  | "qty-low-to-high";

// ─── Internal types ───────────────────────────────────────────────────────────

interface ShopifyImage {
  url: string;
  altText: string | null;
}

interface PickListProduct {
  productId: string;
  productTitle: string;
  productType: string;
  productImage: ShopifyImage | null;
  variants: VariantGroup[];
  totalQuantity: number;
  earliestCreatedAt: string;
  latestCreatedAt: string;
}

interface VariantGroup {
  variantId: string;
  variantTitle: string;
  sku: string | null;
  quantity: number;
  orderNumbers: string[];
}

interface DateRangeOptions {
  startDate?: string;
  endDate?: string;
}

interface PickListOptions extends DateRangeOptions {
  sortBy?: SortBy;
}

interface FetchedOrder {
  id: string;
  name: string;
  createdAt: string;
  fulfillmentOrders?: {
    edges: Array<{
      node: {
        status: string;
        lineItems?: {
          edges: Array<{
            node: {
              id: string;
              remainingQuantity: number;
              variant: {
                id: string;
                title: string;
                sku: string | null;
                product: {
                  id: string;
                  title: string;
                  productType: string;
                  featuredImage: ShopifyImage | null;
                };
              } | null;
            };
          }>;
        };
      };
    }>;
  };
}

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * Vellismith is based in West Bengal, India (IST = UTC+5:30).
 * Date inputs from the filter UI are YYYY-MM-DD strings in the merchant's
 * local calendar. We convert them to UTC using this offset so that the
 * Shopify API query and the in-memory guard both operate on IST-midnight
 * boundaries instead of UTC-midnight ones.
 *
 * Example: "2026-07-05" as startDate → 2026-07-04T18:30:00.000Z (UTC)
 *           "2026-07-05" as endDate   → exclusive end = 2026-07-05T18:30:00.000Z (UTC)
 */
const STORE_TZ_OFFSET_MINUTES = 330; // IST = UTC+5:30

/** IDs-only first pass — max Shopify allows per page. */
const ORDERS_PER_PAGE = 250;

/**
 * Number of orders alias-batched into a single GraphQL request for the
 * fulfillment-order data pass. One batch's Shopify query cost:
 *   ORDERS_PER_BATCH × (1 + FO_PER_ORDER + FO_PER_ORDER × ITEMS_PER_FO)
 *   = 10 × (1 + 3 + 3 × 30) = 10 × 94 = 940 — safely under Shopify's
 *   1 000-point per-call budget.
 *
 * Reduce ORDERS_PER_BATCH (or FO_PER_ORDER / ITEMS_PER_FO) if Shopify
 * starts returning THROTTLED / query-cost errors.
 */
const ORDERS_PER_BATCH = 10;
const FO_PER_ORDER = 3;  // fulfillmentOrders(first:) — Vellismith is single-location so 1 is typical
const ITEMS_PER_FO = 30; // lineItems(first:) per FO — plenty for jewelry orders (typically 1-10)

/** Alias-batch requests to fire in parallel per round. */
const CONCURRENT_BATCHES = 3;

// ─── Exported API ─────────────────────────────────────────────────────────────

export async function generatePickList(
  admin: AdminApiContext,
  options?: PickListOptions
): Promise<PickListProduct[]> {
  try {
    // Phase 1 — lightweight ID fetch for both order statuses concurrently.
    // "unshipped" = nothing fulfilled yet; "partial" = some done, some pending.
    const [unshippedIds, partialIds] = await Promise.all([
      fetchOrderIds(admin, "unshipped", options),
      fetchOrderIds(admin, "partial", options),
    ]);

    // An order can't be both unshipped AND partial at the same time, but
    // deduplication is cheap and guards against any unexpected overlap.
    const allIds = [...new Set([...unshippedIds, ...partialIds])];
    console.log(
      `[picklist] phase 1 — ${unshippedIds.length} unshipped + ` +
      `${partialIds.length} partial = ${allIds.length} unique orders`
    );

    if (allIds.length === 0) return [];

    // Phase 2 — fetch fulfillment order data (remainingQuantity) in alias batches.
    const pickList = await fetchFulfillmentData(admin, allIds);
    console.log(`[picklist] phase 2 — ${pickList.length} products to pick`);

    return sortPickList(pickList, options?.sortBy ?? "alpha");
  } catch (error) {
    console.error("[picklist] generatePickList error:", error);
    throw error;
  }
}

export function filterByProductName(
  pickList: PickListProduct[],
  searchKeyword?: string
): PickListProduct[] {
  if (!searchKeyword?.trim()) return pickList;
  const keyword = searchKeyword.toLowerCase();
  return pickList.filter((p) => p.productTitle.toLowerCase().includes(keyword));
}

export function formatPickListAsText(
  pickList: PickListProduct[],
  options?: { showSku?: boolean; showVariantQuantity?: boolean }
): string {
  const showSku = options?.showSku ?? true;
  const showVariantQuantity = options?.showVariantQuantity ?? true;

  const lines: string[] = [
    "",
    "========================================",
    "          PICKING LIST - UNFULFILLED",
    `          Date: ${new Date().toLocaleDateString()}`,
    "========================================",
    "",
  ];

  for (const product of pickList) {
    lines.push(
      "┌─────────────────────────────────────┐",
      `│ PRODUCT: ${product.productTitle.padEnd(30)} │`,
      `│ Total Qty to Pick: ${String(product.totalQuantity).padEnd(21)} │`,
      "└─────────────────────────────────────┘",
      ""
    );
    if (showVariantQuantity) {
      for (const variant of product.variants) {
        const skuPart = showSku && variant.sku ? ` (SKU: ${variant.sku})` : "";
        lines.push(
          `  Variant: ${variant.variantTitle}${skuPart}`,
          `  Quantity Needed: ${variant.quantity}`,
          "-".repeat(50)
        );
      }
    }
  }

  const totalItems = pickList.reduce((sum, p) => sum + p.totalQuantity, 0);
  lines.push(
    "========================================",
    `  Total Products: ${pickList.length}`,
    `  Total Items: ${totalItems}`,
    "========================================"
  );

  return lines.join("\n");
}

// ─── Date helpers ─────────────────────────────────────────────────────────────

/**
 * Converts a merchant-local YYYY-MM-DD string to a UTC ISO timestamp,
 * treating the input as a date in STORE_TZ_OFFSET_MINUTES timezone.
 *
 * isExclusiveEnd=false → start of that local day in UTC  (used for >=)
 * isExclusiveEnd=true  → start of the *next* local day in UTC (used for <,
 *                        so the entire end date is included)
 *
 * For IST (UTC+5:30), "2026-07-05" with isExclusiveEnd=false:
 *   2026-07-05 00:00:00 IST = 2026-07-04T18:30:00.000Z ✓
 * For IST, "2026-07-05" with isExclusiveEnd=true:
 *   2026-07-06 00:00:00 IST = 2026-07-05T18:30:00.000Z ✓
 */
function localDateToUTCString(dateStr: string, isExclusiveEnd: boolean): string {
  const offsetMs = STORE_TZ_OFFSET_MINUTES * 60 * 1000;
  // Parse as UTC midnight then subtract the store offset → local midnight in UTC.
  const localMidnightUTC = Date.parse(`${dateStr}T00:00:00Z`) - offsetMs;
  // For the exclusive end advance by exactly one local day (86 400 s).
  const adjustedMs = localMidnightUTC + (isExclusiveEnd ? 86_400_000 : 0);
  return new Date(adjustedMs).toISOString();
}

function buildQueryString(status: string, options?: DateRangeOptions): string {
  const conditions = [`fulfillment_status:${status}`];
  if (options?.startDate) {
    conditions.push(`created_at:>="${localDateToUTCString(options.startDate, false)}"`);
  }
  if (options?.endDate) {
    conditions.push(`created_at:<"${localDateToUTCString(options.endDate, true)}"`);
  }
  return conditions.join(" AND ");
}

/**
 * In-memory guard using the same IST-aware UTC boundaries as the API query.
 * Catches any overfetch that can happen at pagination cursor boundaries
 * (rare, but possible when an order is created between the time the query
 * runs and the cursor advances).
 */
function isWithinDateRange(
  createdAt: string,
  startDate?: string,
  endDate?: string
): boolean {
  if (!startDate && !endDate) return true;
  if (startDate && createdAt < localDateToUTCString(startDate, false)) return false;
  if (endDate && createdAt >= localDateToUTCString(endDate, true)) return false;
  return true;
}

// ─── Phase 1: collect order IDs (IDs + createdAt only) ───────────────────────

async function fetchOrderIds(
  admin: AdminApiContext,
  status: string,
  options?: DateRangeOptions
): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | null = null;
  let hasNextPage = true;
  const queryString = buildQueryString(status, options);

  while (hasNextPage) {
    const response: any = await admin.graphql(
      `query GetOrderIds($cursor: String, $query: String!) {
        orders(
          first: ${ORDERS_PER_PAGE},
          after: $cursor,
          query: $query,
          sortKey: CREATED_AT,
          reverse: true
        ) {
          pageInfo { hasNextPage endCursor }
          edges { node { id createdAt } }
        }
      }`,
      { variables: { cursor, query: queryString } }
    );

    const data: any = await response.json();

    if (data.errors) {
      console.error(`[picklist] fetchOrderIds(${status}) errors:`, data.errors);
      break;
    }

    const orders = data.data?.orders;
    if (!orders) break;

    for (const { node } of orders.edges) {
      // In-memory IST-aware guard for exact boundary correctness.
      if (!isWithinDateRange(node.createdAt, options?.startDate, options?.endDate)) continue;
      ids.push(node.id);
    }

    hasNextPage = orders.pageInfo.hasNextPage;
    cursor = orders.pageInfo.endCursor;
  }

  console.log(`[picklist] fetchOrderIds(${status}): ${ids.length} IDs`);
  return ids;
}

// ─── Phase 2: fetch fulfillment data via alias batches ───────────────────────

/**
 * Builds one GraphQL document that alias-fetches fulfillment orders (with
 * remainingQuantity) for up to ORDERS_PER_BATCH order IDs in a single HTTP
 * request. This eliminates the N-per-order round-trips of the naive approach:
 *
 *   Before (naive):  100 orders → 100 individual requests (10 concurrent)
 *   After  (batch):  100 orders → 10 alias-batch requests (3 concurrent)
 *
 * IDs are inlined as literals (not variables) because each batch differs in
 * size and GraphQL has no way to variable-ise a set of aliases. JSON.stringify
 * correctly escapes the Shopify GID strings.
 */
function buildBatchQuery(orderIds: string[]): string {
  const aliases = orderIds.map(
    (id, i) => `
  o${i}: order(id: ${JSON.stringify(id)}) {
    id
    name
    createdAt
    fulfillmentOrders(first: ${FO_PER_ORDER}) {
      edges {
        node {
          status
          lineItems(first: ${ITEMS_PER_FO}) {
            edges {
              node {
                id
                remainingQuantity
                variant {
                  id
                  title
                  sku
                  product {
                    id
                    title
                    productType
                    featuredImage { url altText }
                  }
                }
              }
            }
          }
        }
      }
    }
  }`
  );

  return `query BatchFulfillmentOrders {\n${aliases.join("\n")}\n}`;
}

async function fetchFulfillmentData(
  admin: AdminApiContext,
  orderIds: string[]
): Promise<PickListProduct[]> {
  const productMap = new Map<string, PickListProduct>();
  // Deduplication guard — a line item should only appear in one FO, but
  // this protects against any edge-case double-count.
  const seenLineItemIds = new Set<string>();

  // Split IDs into fixed-size alias batches.
  const batches: string[][] = [];
  for (let i = 0; i < orderIds.length; i += ORDERS_PER_BATCH) {
    batches.push(orderIds.slice(i, i + ORDERS_PER_BATCH));
  }

  // Fire CONCURRENT_BATCHES requests at a time.
  for (let round = 0; round < batches.length; round += CONCURRENT_BATCHES) {
    const concurrent = batches.slice(round, round + CONCURRENT_BATCHES);

    const results = await Promise.allSettled(
      concurrent.map(async (batchIds) => {
        const query = buildBatchQuery(batchIds);
        const response: any = await admin.graphql(query);
        const data: any = await response.json();
        return { data, count: batchIds.length };
      })
    );

    for (const result of results) {
      if (result.status === "rejected") {
        console.error("[picklist] batch request rejected:", result.reason);
        continue;
      }

      const { data, count } = result.value;

      if (data.errors) {
        console.error("[picklist] batch GQL errors:", data.errors);
        continue;
      }

      for (let j = 0; j < count; j++) {
        const order = data.data?.[`o${j}`] as FetchedOrder | undefined;
        if (!order?.fulfillmentOrders?.edges) continue;
        processOrderFulfillments(order, productMap, seenLineItemIds);
      }
    }
  }

  return Array.from(productMap.values());
}

/**
 * Walks a single order's fulfillment orders and accumulates remaining quantities
 * into productMap. Extracted so fetchFulfillmentData stays readable.
 */
function processOrderFulfillments(
  order: FetchedOrder,
  productMap: Map<string, PickListProduct>,
  seenLineItemIds: Set<string>
): void {
  for (const { node: fo } of order.fulfillmentOrders!.edges) {
    // OPEN       = awaiting fulfillment action.
    // IN_PROGRESS = being picked / packed right now.
    // Everything else (CLOSED, CANCELLED, ON_HOLD, SCHEDULED) is skipped.
    if (fo.status !== "OPEN" && fo.status !== "IN_PROGRESS") continue;
    if (!fo.lineItems?.edges) continue;

    for (const { node: li } of fo.lineItems.edges) {
      // remainingQuantity handles every "should skip" case in one field:
      //   • fully fulfilled items            → 0
      //   • items removed by an order edit   → 0
      //   • refunded items                   → 0
      if (li.remainingQuantity <= 0) continue;

      const v = li.variant;
      if (!v?.product) continue; // product deleted from Shopify

      if (seenLineItemIds.has(li.id)) continue;
      seenLineItemIds.add(li.id);

      const p = v.product;
      if (!productMap.has(p.id)) {
        productMap.set(p.id, {
          productId: p.id,
          productTitle: p.title,
          productType: p.productType,
          productImage: p.featuredImage,
          variants: [],
          totalQuantity: 0,
          earliestCreatedAt: order.createdAt,
          latestCreatedAt: order.createdAt,
        });
      }

      const pg = productMap.get(p.id)!;
      if (order.createdAt < pg.earliestCreatedAt) pg.earliestCreatedAt = order.createdAt;
      if (order.createdAt > pg.latestCreatedAt) pg.latestCreatedAt = order.createdAt;

      let vg = pg.variants.find((x) => x.variantId === v.id);
      if (!vg) {
        vg = {
          variantId: v.id,
          variantTitle: v.title,
          sku: v.sku,
          quantity: 0,
          orderNumbers: [],
        };
        pg.variants.push(vg);
      }

      vg.quantity += li.remainingQuantity;
      pg.totalQuantity += li.remainingQuantity;
      if (order.name && !vg.orderNumbers.includes(order.name)) {
        vg.orderNumbers.push(order.name);
      }
    }
  }
}

// ─── Sort ─────────────────────────────────────────────────────────────────────

function sortPickList(list: PickListProduct[], sortBy: SortBy): PickListProduct[] {
  // Always sort variants within each product alphabetically first.
  for (const p of list) {
    p.variants.sort((a, b) =>
      a.variantTitle.toLowerCase().localeCompare(b.variantTitle.toLowerCase())
    );
  }

  const sorted = [...list]; // avoid mutating the original array
  switch (sortBy) {
    case "old-to-new":
      return sorted.sort(
        (a, b) =>
          new Date(a.earliestCreatedAt).getTime() -
          new Date(b.earliestCreatedAt).getTime()
      );
    case "new-to-old":
      return sorted.sort(
        (a, b) =>
          new Date(b.latestCreatedAt).getTime() -
          new Date(a.latestCreatedAt).getTime()
      );
    case "qty-high-to-low":
      return sorted.sort((a, b) => b.totalQuantity - a.totalQuantity);
    case "qty-low-to-high":
      return sorted.sort((a, b) => a.totalQuantity - b.totalQuantity);
    default: // "alpha"
      return sorted.sort((a, b) =>
        a.productTitle.toLowerCase().localeCompare(b.productTitle.toLowerCase())
      );
  }
}