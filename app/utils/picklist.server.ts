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

interface FulfillmentOrder {
  id: string;
  status: string;
  lineItems: {
    pageInfo: {
      hasNextPage: boolean;
      endCursor: string | null;
    };
    edges: Array<{ node: FulfillmentOrderLineItem }>;
  };
}

interface OrderSummary {
  id: string;
  name: string;
  createdAt: string;
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

const MAX_CONCURRENT_ORDER_QUERIES = 5;
const RATE_LIMIT_BASE_DELAY = 1000;

// ─── Main Export ─────────────────────────────────────────────────────────────

export async function generatePickList(
  admin: AdminApiContext,
  options?: PickListOptions
): Promise<PickListProduct[]> {
  if (process.env.NODE_ENV !== "production") {
    console.log("========== GENERATE PICK LIST ==========");
    console.log("options:", JSON.stringify(options, null, 2));
  }

  try {
    const [unshippedSummaries, partialSummaries] = await Promise.all([
      fetchOrderSummaries(admin, "unshipped", options),
      fetchOrderSummaries(admin, "partial", options),
    ]);

    const summaryMap = new Map<string, OrderSummary>();
    for (const summary of [...unshippedSummaries, ...partialSummaries]) {
      if (!summaryMap.has(summary.id)) {
        summaryMap.set(summary.id, summary);
      }
    }

    const orderSummaries = Array.from(summaryMap.values());

    if (process.env.NODE_ENV !== "production") {
      console.log(
        `Found ${orderSummaries.length} orders to process (${unshippedSummaries.length} unshipped, ${partialSummaries.length} partial)`
      );
    }

    const pickList = await processOrdersWithConcurrency(
      admin,
      orderSummaries
    );

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
        const skuPart =
          showSku && variant.sku ? ` (SKU: ${variant.sku})` : "";
        body += `  Variant: ${variant.variantTitle}${skuPart}\n`;
        body += `  Quantity Needed: ${variant.quantity}\n`;
        body += "-".repeat(50) + "\n";
      }
    }
  }

  const totalItems = pickList.reduce(
    (sum, p) => sum + p.totalQuantity,
    0
  );

  const footer = [
    "========================================",
    `  Total Products: ${pickList.length}`,
    `  Total Items: ${totalItems}`,
    "========================================",
  ].join("\n");

  return header + body + footer;
}

// ─── Utility ─────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getNextDayISO(dateString: string): string {
  const date = new Date(`${dateString}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().split("T")[0];
}

// ─── GraphQL Retry Helper ────────────────────────────────────────────────────

/**
 * Raw GraphQL response shape before we know what `data` contains.
 * `data` is deliberately `any` here — each caller casts it to the
 * expected shape after receiving the response.
 */
interface RawGraphQLResponse {
  data?: any;
  errors?: Array<{ message: string; extensions?: { code: string } }>;
  extensions?: {
    cost: {
      actualQueryCost: number;
      throttleStatus: {
        maximumAvailable: number;
        currentlyAvailable: number;
        restoreRate: number;
      };
    };
  };
}

async function graphqlWithRetry(
  admin: AdminApiContext,
  query: string,
  variables: Record<string, unknown>,
  attempt = 0
): Promise<RawGraphQLResponse> {
  const MAX_RETRIES = 3;
  let response: Response;

  try {
    response = await admin.graphql(query, { variables });
  } catch (error) {
    if (attempt < MAX_RETRIES) {
      const delay = RATE_LIMIT_BASE_DELAY * Math.pow(2, attempt);
      if (process.env.NODE_ENV !== "production") {
        console.log(
          `Network error fetching GraphQL, retrying in ${delay}ms (attempt ${attempt + 1}):`,
          error instanceof Error ? error.message : error
        );
      }
      await sleep(delay);
      return graphqlWithRetry(admin, query, variables, attempt + 1);
    }
    throw error;
  }

  if (response.status === 429 || response.status >= 500) {
    if (attempt < MAX_RETRIES) {
      const delay = RATE_LIMIT_BASE_DELAY * Math.pow(2, attempt);
      if (process.env.NODE_ENV !== "production") {
        console.log(
          `HTTP ${response.status}, retrying in ${delay}ms (attempt ${attempt + 1})`
        );
      }
      await sleep(delay);
      return graphqlWithRetry(admin, query, variables, attempt + 1);
    }
    throw new Error(
      `Shopify API returned HTTP ${response.status} after ${MAX_RETRIES} retries`
    );
  }

  const data: RawGraphQLResponse = await response.json();

  if (data.errors) {
    const isRateLimited = data.errors.some(
      (e) =>
        e.extensions?.code === "THROTTLED" ||
        e.message.includes("rate limit") ||
        e.message.includes("throttled")
    );

    if (isRateLimited && attempt < MAX_RETRIES) {
      const delay = RATE_LIMIT_BASE_DELAY * Math.pow(2, attempt);
      if (process.env.NODE_ENV !== "production") {
        console.log(
          `GraphQL rate limited, retrying in ${delay}ms (attempt ${attempt + 1})`
        );
      }
      await sleep(delay);
      return graphqlWithRetry(admin, query, variables, attempt + 1);
    }
  }

  return data;
}

// ─── Step 1: Fetch Order Summaries (lightweight) ─────────────────────────────

function buildQueryString(
  status: "unshipped" | "partial",
  options?: DateRangeOptions
): string {
  const conditions: string[] = [];
  conditions.push(`fulfillment_status:${status}`);

  if (options?.startDate) {
    conditions.push(`created_at:>="${options.startDate}T00:00:00Z"`);
  }

  if (options?.endDate) {
    const endExclusive = getNextDayISO(options.endDate);
    conditions.push(`created_at:<"${endExclusive}"`);
  }

  return conditions.join(" AND ");
}

async function fetchOrderSummaries(
  admin: AdminApiContext,
  status: "unshipped" | "partial",
  options?: DateRangeOptions
): Promise<OrderSummary[]> {
  const summaries: OrderSummary[] = [];
  let hasNextPage = true;
  let cursor: string | null = null;

  const queryString = buildQueryString(status, options);

  while (hasNextPage) {
    const query = `
      query GetOrderSummaries($cursor: String, $query: String!) {
        orders(
          first: ${ORDERS_PER_PAGE},
          after: $cursor,
          query: $query,
          sortKey: CREATED_AT,
          reverse: true
        ) {
          pageInfo {
            hasNextPage
            endCursor
          }
          edges {
            node {
              id
              name
              createdAt
            }
          }
        }
      }`;

    const raw = await graphqlWithRetry(admin, query, {
      cursor,
      query: queryString,
    });

    if (raw.errors) {
      console.error(`GraphQL errors (${status}):`, raw.errors);
      throw new Error(`GraphQL error: ${raw.errors[0].message}`);
    }

    if (process.env.NODE_ENV !== "production" && raw.extensions?.cost) {
      console.log(
        `Order summary query cost (${status}): ${raw.extensions.cost.actualQueryCost}`
      );
    }

    const ordersData = raw.data?.orders as
      | {
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
          edges: Array<{ node: OrderSummary }>;
        }
      | undefined;

    if (!ordersData) {
      throw new Error(`Failed to fetch ${status} orders from Shopify`);
    }

    for (const edge of ordersData.edges) {
      summaries.push(edge.node);
    }

    hasNextPage = ordersData.pageInfo.hasNextPage;
    cursor = ordersData.pageInfo.endCursor;
  }

  return filterOrderSummariesByDateRange(
    summaries,
    options?.startDate,
    options?.endDate
  );
}

function filterOrderSummariesByDateRange(
  summaries: OrderSummary[],
  startDate?: string,
  endDate?: string
): OrderSummary[] {
  if (!startDate && !endDate) return summaries;

  return summaries.filter((order) => {
    const orderDate = order.createdAt;

    if (startDate) {
      if (orderDate < `${startDate}T00:00:00Z`) return false;
    }

    if (endDate) {
      const endExclusive = `${getNextDayISO(endDate)}T00:00:00Z`;
      if (orderDate >= endExclusive) return false;
    }

    return true;
  });
}

// ─── Step 2: Fetch Fulfillment Orders Per Order ──────────────────────────────

async function fetchFulfillmentOrdersForOrder(
  admin: AdminApiContext,
  orderId: string
): Promise<FulfillmentOrder[]> {
  const allFulfillmentOrders: FulfillmentOrder[] = [];
  let cursor: string | null = null;

  do {
    const query = `
      query GetFulfillmentOrdersForOrder($orderId: ID!, $cursor: String) {
        order(id: $orderId) {
          id
          fulfillmentOrders(
            first: ${FULFILLMENT_ORDERS_PER_ORDER},
            after: $cursor,
            reverse: true
          ) {
            pageInfo {
              hasNextPage
              endCursor
            }
            edges {
              node {
                id
                status
                lineItems(first: ${LINE_ITEMS_PER_FO}) {
                  pageInfo {
                    hasNextPage
                    endCursor
                  }
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
                          featuredImage {
                            url
                            altText
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }`;

    const raw = await graphqlWithRetry(admin, query, { orderId, cursor });

    if (raw.errors) {
      console.error(
        `GraphQL errors fetching fulfillment orders for ${orderId}:`,
        raw.errors
      );
      break;
    }

    if (process.env.NODE_ENV !== "production" && raw.extensions?.cost) {
      console.log(
        `Fulfillment order query cost (${orderId}): ${raw.extensions.cost.actualQueryCost}`
      );
    }

    const order = raw.data?.order as
      | {
          id: string;
          fulfillmentOrders: {
            pageInfo: { hasNextPage: boolean; endCursor: string | null };
            edges: Array<{
              node: {
                id: string;
                status: string;
                lineItems: {
                  pageInfo: { hasNextPage: boolean; endCursor: string | null };
                  edges: Array<{ node: FulfillmentOrderLineItem }>;
                };
              };
            }>;
          };
        }
      | undefined;

    if (!order?.fulfillmentOrders) break;

    const foData = order.fulfillmentOrders;

    for (const edge of foData.edges) {
      const fo = edge.node;

      if (fo.lineItems.pageInfo.hasNextPage && fo.lineItems.pageInfo.endCursor) {
        const allLineItems = await fetchAllLineItemsForFO(
          admin,
          fo.id,
          fo.lineItems.edges,
          fo.lineItems.pageInfo.endCursor
        );
        allFulfillmentOrders.push({
          id: fo.id,
          status: fo.status,
          lineItems: {
            pageInfo: { hasNextPage: false, endCursor: null },
            edges: allLineItems,
          },
        });
      } else {
        allFulfillmentOrders.push({
          id: fo.id,
          status: fo.status,
          lineItems: {
            pageInfo: { hasNextPage: false, endCursor: null },
            edges: fo.lineItems.edges,
          },
        });
      }
    }

    cursor = foData.pageInfo.hasNextPage
      ? foData.pageInfo.endCursor
      : null;
  } while (cursor);

  return allFulfillmentOrders;
}

async function fetchAllLineItemsForFO(
  admin: AdminApiContext,
  fulfillmentOrderId: string,
  existingEdges: Array<{ node: FulfillmentOrderLineItem }>,
  cursor: string
): Promise<Array<{ node: FulfillmentOrderLineItem }>> {
  const allEdges = [...existingEdges];
  let currentCursor: string | null = cursor;

  while (currentCursor) {
    const query = `
      query GetFulfillmentOrderLineItems($id: ID!, $cursor: String) {
        node(id: $id) {
          ... on FulfillmentOrder {
            id
            lineItems(first: ${LINE_ITEMS_PER_FO}, after: $cursor) {
              pageInfo {
                hasNextPage
                endCursor
              }
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
                      featuredImage {
                        url
                        altText
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }`;

    const raw = await graphqlWithRetry(admin, query, {
      id: fulfillmentOrderId,
      cursor: currentCursor,
    });

    if (raw.errors) {
      console.error(
        `GraphQL errors paginating line items for FO ${fulfillmentOrderId}:`,
        raw.errors
      );
      break;
    }

    const fo = raw.data?.node as
      | {
          id: string;
          lineItems: {
            pageInfo: { hasNextPage: boolean; endCursor: string | null };
            edges: Array<{ node: FulfillmentOrderLineItem }>;
          };
        }
      | undefined;

    if (!fo?.lineItems?.edges) break;

    allEdges.push(...fo.lineItems.edges);

    currentCursor = fo.lineItems.pageInfo.hasNextPage
      ? fo.lineItems.pageInfo.endCursor
      : null;
  }

  return allEdges;
}

// ─── Step 3: Process Orders with Concurrency ─────────────────────────────────

interface ProcessedOrderData {
  fulfillmentOrders: FulfillmentOrder[];
  orderName: string;
  orderDate: string;
}

async function processOrdersWithConcurrency(
  admin: AdminApiContext,
  orderSummaries: OrderSummary[]
): Promise<PickListProduct[]> {
  const productMap = new Map<string, PickListProduct>();
  const processedLineItemIds = new Set<string>();

  for (let i = 0; i < orderSummaries.length; i += MAX_CONCURRENT_ORDER_QUERIES) {
    const batch = orderSummaries.slice(i, i + MAX_CONCURRENT_ORDER_QUERIES);

    if (process.env.NODE_ENV !== "production") {
      console.log(
        `Processing batch ${Math.floor(i / MAX_CONCURRENT_ORDER_QUERIES) + 1}: orders ${i + 1}-${Math.min(i + MAX_CONCURRENT_ORDER_QUERIES, orderSummaries.length)}`
      );
    }

    const batchResults = await Promise.all(
      batch.map(async (summary): Promise<ProcessedOrderData> => {
        const fulfillmentOrders = await fetchFulfillmentOrdersForOrder(
          admin,
          summary.id
        );
        return {
          fulfillmentOrders,
          orderName: summary.name,
          orderDate: summary.createdAt,
        };
      })
    );

    for (const result of batchResults) {
      aggregateFulfillmentOrders(
        result,
        productMap,
        processedLineItemIds
      );
    }
  }

  return Array.from(productMap.values());
}

function aggregateFulfillmentOrders(
  orderData: ProcessedOrderData,
  productMap: Map<string, PickListProduct>,
  processedLineItemIds: Set<string>
): void {
  const { fulfillmentOrders, orderName, orderDate } = orderData;

  for (const fo of fulfillmentOrders) {
    if (
      fo.status === "CLOSED" ||
      fo.status === "CANCELLED" ||
      fo.status === "INCOMPLETE"
    ) {
      continue;
    }

    if (!fo.lineItems?.edges) continue;

    for (const { node: lineItem } of fo.lineItems.edges) {
      if (lineItem.remainingQuantity <= 0) continue;

      const variant = lineItem.variant;
      if (!variant?.product) continue;

      if (processedLineItemIds.has(lineItem.id)) {
        if (process.env.NODE_ENV !== "production") {
          console.log(
            `Skipping duplicate line item: ${lineItem.id} (order: ${orderName})`
          );
        }
        continue;
      }

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
          earliestCreatedAt: orderDate,
          latestCreatedAt: orderDate,
        });
      }

      const productGroup = productMap.get(productKey)!;

      if (orderDate < productGroup.earliestCreatedAt) {
        productGroup.earliestCreatedAt = orderDate;
      }
      if (orderDate > productGroup.latestCreatedAt) {
        productGroup.latestCreatedAt = orderDate;
      }

      let variantGroup = productGroup.variants.find(
        (v) => v.variantId === variant.id
      );

      if (!variantGroup) {
        variantGroup = {
          variantId: variant.id,
          variantTitle: variant.title,
          sku: variant.sku,
          quantity: 0,
          orderNumbers: [],
        };
        productGroup.variants.push(variantGroup);
      }

      variantGroup.quantity += lineItem.remainingQuantity;
      productGroup.totalQuantity += lineItem.remainingQuantity;

      if (orderName && !variantGroup.orderNumbers.includes(orderName)) {
        variantGroup.orderNumbers.push(orderName);
      }
    }
  }
}

// ─── Sort ────────────────────────────────────────────────────────────────────

function sortPickList(
  pickList: PickListProduct[],
  sortBy: SortBy
): PickListProduct[] {
  for (const product of pickList) {
    product.variants.sort((a, b) => {
      const variantA = a.variantTitle.toLowerCase();
      const variantB = b.variantTitle.toLowerCase();
      if (variantA < variantB) return -1;
      if (variantA > variantB) return 1;
      return 0;
    });
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
      return [...pickList].sort(
        (a, b) => b.totalQuantity - a.totalQuantity
      );

    case "qty-low-to-high":
      return [...pickList].sort(
        (a, b) => a.totalQuantity - b.totalQuantity
      );

    case "alpha":
    default:
      return [...pickList].sort((a, b) => {
        const nameA = a.productTitle.toLowerCase();
        const nameB = b.productTitle.toLowerCase();
        if (nameA < nameB) return -1;
        if (nameA > nameB) return 1;
        return 0;
      });
  }
}