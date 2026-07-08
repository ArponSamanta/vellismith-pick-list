import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";

// ─── Types ───────────────────────────────────────────────────────────────────

export type SortBy =
  | "alpha"
  | "old-to-new"
  | "new-to-old"
  | "qty-high-to-low"
  | "qty-low-to-high";

interface ShopifyImage {
  url: string;
  altText: string | null;
}

interface FulfillmentOrderLineItem {
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

// ─── Configuration ───────────────────────────────────────────────────────────

const ORDERS_PER_PAGE = 50;
const FULFILLMENT_ORDERS_PER_ORDER = 20;
const LINE_ITEMS_PER_FO = 250;
const RATE_LIMIT_BASE_DELAY = 1000;
const ORDERS_PER_BATCH = 5;

// ─── Main Export ─────────────────────────────────────────────────────────────

export async function generatePickList(
  admin: AdminApiContext,
  options?: PickListOptions
): Promise<PickListProduct[]> {
  const totalStartTime = Date.now();

  if (process.env.NODE_ENV !== "production") {
    console.log("========== GENERATE PICK LIST ==========");
    console.log("options:", JSON.stringify(options, null, 2));
  }

  try {
    const [unshippedSummaries, partialSummaries] = await Promise.all([
      fetchOrderSummaries(admin, "unshipped", options),
      fetchOrderSummaries(admin, "partial", options),
    ]);

    const summaryMap = new Map<string, { name: string; createdAt: string }>();
    for (const s of [...unshippedSummaries, ...partialSummaries]) {
      if (!summaryMap.has(s.id)) {
        summaryMap.set(s.id, { name: s.name, createdAt: s.createdAt });
      }
    }

    const orderIds = Array.from(summaryMap.keys());

    if (process.env.NODE_ENV !== "production") {
      console.log(
        `Found ${orderIds.length} orders in ${Date.now() - totalStartTime}ms`
      );
    }

    if (orderIds.length === 0) return [];

    const pickList = await processOrdersInBatches(admin, orderIds, summaryMap);

    if (process.env.NODE_ENV !== "production") {
      console.log(
        `Total time: ${Date.now() - totalStartTime}ms, ${pickList.length} products`
      );
    }

    return sortPickList(pickList, options?.sortBy || "alpha");
  } catch (error) {
    console.error("Error in generatePickList:", error);
    throw error;
  }
}

export function filterByProductName(
  pickList: PickListProduct[],
  searchKeyword?: string
): PickListProduct[] {
  if (!searchKeyword?.trim()) return pickList;
  const keyword = searchKeyword.toLowerCase();
  return pickList.filter((product) =>
    product.productTitle.toLowerCase().includes(keyword)
  );
}

export function formatPickListAsText(
  pickList: PickListProduct[],
  options?: {
    showSku?: boolean;
    showVariantQuantity?: boolean;
  }
): string {
  const showSku = options?.showSku ?? true;
  const showVariantQuantity = options?.showVariantQuantity ?? true;

  const header = [
    "",
    "========================================",
    "          PICKING LIST - UNFULFILLED",
    `          Date: ${new Date().toLocaleDateString()}`,
    "========================================",
    "",
  ].join("\n");

  let body = "";
  for (const product of pickList) {
    body += [
      "┌─────────────────────────────────────┐",
      `│ PRODUCT: ${product.productTitle.padEnd(30)} │`,
      `│ Total Qty to Pick: ${String(product.totalQuantity).padEnd(21)} │`,
      "└─────────────────────────────────────┘",
      "",
    ].join("\n");

    if (showVariantQuantity) {
      for (const variant of product.variants) {
        const skuPart = showSku && variant.sku ? ` (SKU: ${variant.sku})` : "";
        body += `  Variant: ${variant.variantTitle}${skuPart}\n`;
        body += `  Quantity Needed: ${variant.quantity}\n`;
        body += "-".repeat(50) + "\n";
      }
    }
  }

  const totalItems = pickList.reduce((sum, p) => sum + p.totalQuantity, 0);
  const footer = [
    "========================================",
    `  Total Products: ${pickList.length}`,
    `  Total Items: ${totalItems}`,
    "========================================",
  ].join("\n");

  return header + body + footer;
}

// ─── Utility ─────────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function getNextDayISO(dateString: string): string {
  const date = new Date(`${dateString}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().split("T")[0];
}

// ─── GraphQL Retry Helper ────────────────────────────────────────────────────

/**
 * Use `any` for the response type since the Shopify client returns
 * `FetchResponseBody<any>` which has a different shape than our
 * custom interfaces. We validate the data at each call site.
 */
async function graphqlWithRetry(
  admin: AdminApiContext,
  query: string,
  variables: Record<string, unknown>,
  attempt = 0
): Promise<any> {
  const MAX_RETRIES = 3;

  try {
    const response: any = await admin.graphql(query, { variables });

    // The Shopify client returns the body directly. Errors come in
    // the response body as an errors array, or the client throws
    // on HTTP errors.
    if (response?.errors) {
      const isRateLimited = response.errors.some(
        (e: any) => e?.extensions?.code === "THROTTLED"
      );
      if (isRateLimited && attempt < MAX_RETRIES) {
        await sleep(RATE_LIMIT_BASE_DELAY * Math.pow(2, attempt));
        return graphqlWithRetry(admin, query, variables, attempt + 1);
      }
    }

    return response;
  } catch (error: any) {
    // HTTP errors (429, 5xx) and network errors are thrown
    const status = error?.response?.status || error?.status;
    if ((status === 429 || (status && status >= 500)) && attempt < MAX_RETRIES) {
      await sleep(RATE_LIMIT_BASE_DELAY * Math.pow(2, attempt));
      return graphqlWithRetry(admin, query, variables, attempt + 1);
    }

    if (attempt < MAX_RETRIES) {
      await sleep(RATE_LIMIT_BASE_DELAY * Math.pow(2, attempt));
      return graphqlWithRetry(admin, query, variables, attempt + 1);
    }

    throw error;
  }
}

// ─── Step 1: Fetch Order Summaries ──────────────────────────────────────────

function buildQueryString(
  status: "unshipped" | "partial",
  options?: DateRangeOptions
): string {
  const conditions = [`fulfillment_status:${status}`];
  if (options?.startDate) {
    conditions.push(`created_at:>="${options.startDate}T00:00:00Z"`);
  }
  if (options?.endDate) {
    conditions.push(
      `created_at:<"${getNextDayISO(options.endDate)}T00:00:00Z"`
    );
  }
  return conditions.join(" AND ");
}

async function fetchOrderSummaries(
  admin: AdminApiContext,
  status: "unshipped" | "partial",
  options?: DateRangeOptions
): Promise<Array<{ id: string; name: string; createdAt: string }>> {
  const summaries: Array<{ id: string; name: string; createdAt: string }> = [];
  let hasNextPage = true;
  let cursor: string | null = null;
  const queryString = buildQueryString(status, options);

  while (hasNextPage) {
    const data = await graphqlWithRetry(
      admin,
      `query GetOrderSummaries($cursor: String, $query: String!) {
        orders(first: ${ORDERS_PER_PAGE}, after: $cursor, query: $query, sortKey: CREATED_AT, reverse: true) {
          pageInfo { hasNextPage, endCursor }
          edges { node { id, name, createdAt } }
        }
      }`,
      { cursor, query: queryString }
    );

    if (data.errors) throw new Error(`GraphQL error: ${data.errors[0].message}`);

    const orders = data.data?.orders as {
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      edges: Array<{ node: { id: string; name: string; createdAt: string } }>;
    } | undefined;

    if (!orders) break;

    for (const edge of orders.edges) {
      const d = edge.node.createdAt;
      if (options?.startDate && d < `${options.startDate}T00:00:00Z`) continue;
      if (options?.endDate && d >= `${getNextDayISO(options.endDate)}T00:00:00Z`) continue;
      summaries.push(edge.node);
    }

    hasNextPage = orders.pageInfo.hasNextPage;
    cursor = orders.pageInfo.endCursor;
  }

  return summaries;
}

// ─── Step 2: Batch Fetch Fulfillment Orders ─────────────────────────────────

function buildBatchedQuery(orderIds: string[]): string {
  const fragments = orderIds
    .map(
      (id, i) => `
      o${i}: order(id: "${id}") {
        id
        fulfillmentOrders(first: ${FULFILLMENT_ORDERS_PER_ORDER}, reverse: true) {
          edges {
            node {
              id
              status
              lineItems(first: ${LINE_ITEMS_PER_FO}) {
                edges {
                  node {
                    id
                    remainingQuantity
                    variant {
                      id, title, sku
                      product {
                        id, title, productType
                        featuredImage { url, altText }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }`
    )
    .join("\n");

  return `query BatchedFulfillmentOrders { ${fragments} }`;
}

async function processOrdersInBatches(
  admin: AdminApiContext,
  orderIds: string[],
  orderMeta: Map<string, { name: string; createdAt: string }>
): Promise<PickListProduct[]> {
  const productMap = new Map<string, PickListProduct>();
  const processedLineItemIds = new Set<string>();

  for (let i = 0; i < orderIds.length; i += ORDERS_PER_BATCH) {
    const batch = orderIds.slice(i, i + ORDERS_PER_BATCH);
    const batchStart = Date.now();

    const query = buildBatchedQuery(batch);
    const data = await graphqlWithRetry(admin, query, {});

    if (data.errors) {
      console.error(`Batch query errors:`, data.errors);
      continue;
    }

    if (process.env.NODE_ENV !== "production") {
      const cost = data.extensions?.cost?.actualQueryCost ?? "?";
      console.log(
        `Batch ${Math.floor(i / ORDERS_PER_BATCH) + 1}: ${batch.length} orders in ${Date.now() - batchStart}ms, cost: ${cost}`
      );
    }

    for (let j = 0; j < batch.length; j++) {
      const orderId = batch[j];
      const alias = `o${j}`;
      const orderData = data.data?.[alias] as {
        fulfillmentOrders?: {
          edges: Array<{
            node: {
              id: string;
              status: string;
              lineItems: {
                edges: Array<{ node: FulfillmentOrderLineItem }>;
              };
            };
          }>;
        };
      } | undefined;

      if (!orderData?.fulfillmentOrders?.edges) continue;

      const meta = orderMeta.get(orderId);
      if (!meta) continue;

      for (const foEdge of orderData.fulfillmentOrders.edges) {
        const fo = foEdge.node;

        if (
          fo.status === "CLOSED" ||
          fo.status === "CANCELLED" ||
          fo.status === "INCOMPLETE"
        ) continue;

        if (!fo.lineItems?.edges) continue;

        for (const { node: lineItem } of fo.lineItems.edges) {
          if (lineItem.remainingQuantity <= 0) continue;

          const variant = lineItem.variant;
          if (!variant?.product) continue;

          if (processedLineItemIds.has(lineItem.id)) continue;
          processedLineItemIds.add(lineItem.id);

          const product = variant.product;
          const productKey = product.id;

          if (!productMap.has(productKey)) {
            productMap.set(productKey, {
              productId: product.id,
              productTitle: product.title,
              productType: product.productType,
              productImage: product.featuredImage,
              variants: [],
              totalQuantity: 0,
              earliestCreatedAt: meta.createdAt,
              latestCreatedAt: meta.createdAt,
            });
          }

          const pg = productMap.get(productKey)!;

          if (meta.createdAt < pg.earliestCreatedAt) {
            pg.earliestCreatedAt = meta.createdAt;
          }
          if (meta.createdAt > pg.latestCreatedAt) {
            pg.latestCreatedAt = meta.createdAt;
          }

          let vg = pg.variants.find((v) => v.variantId === variant.id);
          if (!vg) {
            vg = {
              variantId: variant.id,
              variantTitle: variant.title,
              sku: variant.sku,
              quantity: 0,
              orderNumbers: [],
            };
            pg.variants.push(vg);
          }

          vg.quantity += lineItem.remainingQuantity;
          pg.totalQuantity += lineItem.remainingQuantity;

          if (meta.name && !vg.orderNumbers.includes(meta.name)) {
            vg.orderNumbers.push(meta.name);
          }
        }
      }
    }
  }

  return Array.from(productMap.values());
}

// ─── Sort ────────────────────────────────────────────────────────────────────

function sortPickList(
  pickList: PickListProduct[],
  sortBy: SortBy
): PickListProduct[] {
  for (const product of pickList) {
    product.variants.sort((a, b) =>
      a.variantTitle.toLowerCase().localeCompare(b.variantTitle.toLowerCase())
    );
  }

  switch (sortBy) {
    case "old-to-new":
      return [...pickList].sort(
        (a, b) =>
          new Date(a.earliestCreatedAt).getTime() -
          new Date(b.earliestCreatedAt).getTime()
      );
    case "new-to-old":
      return [...pickList].sort(
        (a, b) =>
          new Date(b.latestCreatedAt).getTime() -
          new Date(a.latestCreatedAt).getTime()
      );
    case "qty-high-to-low":
      return [...pickList].sort((a, b) => b.totalQuantity - a.totalQuantity);
    case "qty-low-to-high":
      return [...pickList].sort((a, b) => a.totalQuantity - b.totalQuantity);
    case "alpha":
    default:
      return [...pickList].sort((a, b) =>
        a.productTitle.toLowerCase().localeCompare(b.productTitle.toLowerCase())
      );
  }
}