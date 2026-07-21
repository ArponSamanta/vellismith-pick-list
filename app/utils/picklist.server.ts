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
 *   = 5 × (1 + 2 + 2 × 20) = 5 × 43 = 215 points.
 *
 * What actually matters for throttling is the *concurrent* cost, since the
 * leaky bucket (1 000 points, refilling ~50/sec on a standard store) is shared
 * across in-flight requests:
 *   CONCURRENT_BATCHES × 215 = 2 × 215 = 430  — comfortably under 1 000.
 *
 * The previous values (10/3/30 × 3 concurrent) demanded 3 × 940 = 2 820 points
 * at once against a 1 000 bucket, which is exactly why batches were throttled.
 * graphqlWithRetry now recovers from any residual throttle, but keeping the
 * steady-state demand under budget avoids the retries entirely.
 *
 * Reduce these further if Shopify still returns THROTTLED / query-cost errors;
 * raise ITEMS_PER_FO / FO_PER_ORDER only if orders start truncating.
 */
const ORDERS_PER_BATCH = 5;
const FO_PER_ORDER = 2;  // fulfillmentOrders(first:) — Vellismith is single-location so 1 is typical
const ITEMS_PER_FO = 20; // lineItems(first:) per FO — plenty for jewelry orders (typically 1-10)

/** Alias-batch requests to fire in parallel per round. */
const CONCURRENT_BATCHES = 2;

// ─── Exported API ─────────────────────────────────────────────────────────────

export async function generatePickList(
  admin: AdminApiContext,
  options?: PickListOptions
): Promise<PickListProduct[]> {
  try {
    // Phase 1 — lightweight ID fetch for both order statuses concurrently.
    // "unfulfilled" = nothing fulfilled yet; "partial" = some done, some pending.
    // These two match Shopify Admin's "Unfulfilled" + "Partially fulfilled"
    // filters exactly — every order that still owes the customer items to pick.
    //
    // NOTE: this previously used "unshipped", which is a DIFFERENT, narrower
    // Shopify search value (marked-for-fulfillment-but-not-shipped). It silently
    // missed genuinely unfulfilled orders, so any date-scoped query could come
    // back empty even when the Admin clearly showed unfulfilled orders in range.
    const [unfulfilledIds, partialIds] = await Promise.all([
      fetchOrderIds(admin, "unfulfilled", options),
      fetchOrderIds(admin, "partial", options),
    ]);

    // An order can't be both unfulfilled AND partial at the same time, but
    // deduplication is cheap and guards against any unexpected overlap.
    const allIds = [...new Set([...unfulfilledIds, ...partialIds])];
    console.log(
      `[picklist] phase 1 — ${unfulfilledIds.length} unfulfilled + ` +
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

/**
 * Returns the access scopes actually GRANTED to this app installation.
 *
 * This is deliberately read from Shopify rather than from the SCOPES env var:
 * the env var is only what we *request*. The scopes a token actually carries
 * change only when the merchant re-authorises the app, and `read_all_orders`
 * additionally requires Shopify to approve it for the app first. So the env var
 * can list read_all_orders while the live token still lacks it — which looks
 * exactly like "the 60-day limit is still broken".
 */
export async function fetchGrantedScopes(
  admin: AdminApiContext
): Promise<string[]> {
  try {
    const data: any = await graphqlWithRetry(
      admin,
      `query GrantedScopes { currentAppInstallation { accessScopes { handle } } }`
    );
    const scopes: string[] = (
      data?.data?.currentAppInstallation?.accessScopes ?? []
    ).map((s: any) => s.handle);
    console.log(`[picklist] granted scopes (${scopes.length}): ${scopes.join(", ")}`);
    console.log(
      `[picklist] read_all_orders granted: ${scopes.includes("read_all_orders")}`
    );
    return scopes;
  } catch (error) {
    console.error("[picklist] could not read granted scopes:", error);
    return [];
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
  // Shopify's search DSL expects second-precision timestamps; strip the
  // milliseconds toISOString() always adds.
  return new Date(adjustedMs).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function buildQueryString(status: string, options?: DateRangeOptions): string {
  const conditions = [`fulfillment_status:${status}`];
  // Filter on processed_at, NOT created_at. Shopify Admin's Orders list "Date"
  // column and its date filter use the order's *processed* date (processed_at).
  // For orders imported/migrated into the store (or created by some checkout
  // apps), created_at is the date the Shopify record was created — often the
  // import date — while processed_at is the real order date the merchant sees.
  // Filtering on created_at silently misses those orders (e.g. a May range came
  // back empty because those orders' created_at was the July import date).
  //
  // Single quotes are required around the datetime value — double quotes cause
  // the clause to be mis-parsed as a phrase rather than a date comparison.
  if (options?.startDate) {
    conditions.push(`processed_at:>='${localDateToUTCString(options.startDate, false)}'`);
  }
  if (options?.endDate) {
    conditions.push(`processed_at:<'${localDateToUTCString(options.endDate, true)}'`);
  }
  return conditions.join(" AND ");
}

/**
 * In-memory guard using the same IST-aware UTC boundaries as the API query.
 * Catches any overfetch that can happen at pagination cursor boundaries, and —
 * more importantly — acts as a hard backstop if Shopify's API-side date filter
 * ever fails to apply, so out-of-range orders can never inflate the pick list.
 *
 * `orderDate` is the order's processed_at (the field we filter on), passed in
 * as the raw ISO string Shopify returned. Comparison is done on epoch
 * milliseconds (via Date.parse), NOT on the raw ISO strings: Shopify may return
 * the timestamp as "...Z" or with a "+05:30" offset, and comparing two
 * differently-formatted ISO strings lexicographically is unreliable near
 * midnight boundaries, whereas epoch comparison is exact.
 */
function isWithinDateRange(
  orderDate: string,
  startDate?: string,
  endDate?: string
): boolean {
  if (!startDate && !endDate) return true;
  const t = Date.parse(orderDate);
  if (Number.isNaN(t)) return true; // unparseable/null — don't drop it on the guard's account
  if (startDate && t < Date.parse(localDateToUTCString(startDate, false))) return false;
  if (endDate && t >= Date.parse(localDateToUTCString(endDate, true))) return false;
  return true;
}

// ─── Throttle-aware GraphQL ──────────────────────────────────────────────────

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Max times a single throttled request is retried before we give up on it. */
const MAX_THROTTLE_RETRIES = 6;

/**
 * Wraps admin.graphql with automatic retry on Shopify rate-limit throttling.
 *
 * Shopify surfaces a throttle two different ways and we must handle both:
 *   1. The client THROWS a GraphqlQueryError whose message contains "Throttled".
 *   2. The client RETURNS a 200 body carrying errors[].extensions.code ===
 *      "THROTTLED" alongside extensions.cost.throttleStatus.
 *
 * When throttleStatus is present we wait exactly long enough for the leaky
 * bucket to refill the missing points; otherwise we fall back to capped
 * exponential backoff with jitter. Previously a throttled batch was caught and
 * silently skipped, so its orders never reached the pick list — producing an
 * incomplete list that looked like a broken date filter.
 */
async function graphqlWithRetry(
  admin: AdminApiContext,
  query: string,
  variables?: Record<string, unknown>
): Promise<any> {
  for (let attempt = 0; ; attempt++) {
    try {
      const response: any = await admin.graphql(
        query,
        variables ? { variables } : undefined
      );
      const data: any = await response.json();

      const throttled =
        Array.isArray(data?.errors) &&
        data.errors.some((e: any) => e?.extensions?.code === "THROTTLED");

      if (throttled && attempt < MAX_THROTTLE_RETRIES) {
        await sleep(throttleWaitMs(data, attempt));
        continue;
      }
      return data;
    } catch (error: any) {
      const isThrottle = /throttl/i.test(error?.message ?? "");
      if (isThrottle && attempt < MAX_THROTTLE_RETRIES) {
        console.warn(
          `[picklist] throttled (thrown), retry ${attempt + 1}/${MAX_THROTTLE_RETRIES}`
        );
        await sleep(throttleWaitMs(null, attempt));
        continue;
      }
      throw error;
    }
  }
}

/**
 * How long to wait before retrying a throttled request. Prefers Shopify's own
 * throttleStatus (which tells us the exact refill time) and otherwise falls
 * back to capped exponential backoff with a little jitter.
 */
function throttleWaitMs(data: any, attempt: number): number {
  const cost = data?.extensions?.cost;
  const status = cost?.throttleStatus;
  if (status && typeof status.currentlyAvailable === "number") {
    const needed = cost.requestedQueryCost ?? 0;
    const deficit = needed - status.currentlyAvailable;
    const restoreRate = status.restoreRate || 50;
    if (deficit > 0) return Math.ceil((deficit / restoreRate) * 1000) + 250;
  }
  const backoff = Math.min(1000 * 2 ** attempt, 8000);
  return backoff + Math.floor(Math.random() * 300);
}

// ─── Phase 1: collect order IDs (IDs + dates only) ───────────────────────────

async function fetchOrderIds(
  admin: AdminApiContext,
  status: string,
  options?: DateRangeOptions
): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | null = null;
  let hasNextPage = true;
  let totalFetched = 0; // how many the API returned, before the in-memory guard
  let sampleDates: string | null = null;
  const queryString = buildQueryString(status, options);
  console.log(`[picklist] fetchOrderIds(${status}) query: ${queryString}`);

  while (hasNextPage) {
    const data: any = await graphqlWithRetry(
      admin,
      `query GetOrderIds($cursor: String, $query: String!) {
        orders(
          first: ${ORDERS_PER_PAGE},
          after: $cursor,
          query: $query,
          sortKey: PROCESSED_AT,
          reverse: true
        ) {
          pageInfo { hasNextPage endCursor }
          edges { node { id createdAt processedAt } }
        }
      }`,
      { cursor, query: queryString }
    );

    if (data.errors) {
      console.error(`[picklist] fetchOrderIds(${status}) errors:`, data.errors);
      break;
    }

    const orders = data.data?.orders;
    if (!orders) break;

    for (const { node } of orders.edges) {
      totalFetched++;
      if (sampleDates === null) {
        sampleDates = `processedAt=${node.processedAt} createdAt=${node.createdAt}`;
      }
      // In-memory IST-aware guard on the SAME field we filter by (processed_at).
      if (!isWithinDateRange(node.processedAt, options?.startDate, options?.endDate)) continue;
      ids.push(node.id);
    }

    hasNextPage = orders.pageInfo.hasNextPage;
    cursor = orders.pageInfo.endCursor;
  }

  // If a date range is set and totalFetched >> ids.length, Shopify's API-side
  // filter isn't applying and the in-memory guard is doing all the work — the
  // sample dates reveal which field/format so we can tell why.
  console.log(
    `[picklist] fetchOrderIds(${status}): API returned ${totalFetched}, ` +
    `kept ${ids.length} after date guard` +
    (sampleDates ? ` (sample ${sampleDates})` : "")
  );
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
        const data: any = await graphqlWithRetry(admin, buildBatchQuery(batchIds));
        return { data, count: batchIds.length };
      })
    );

    for (const result of results) {
      if (result.status === "rejected") {
        // With graphqlWithRetry a throttle no longer lands here; a rejection
        // now means a genuine (non-throttle) failure worth surfacing loudly.
        console.error("[picklist] batch request failed after retries:", result.reason);
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