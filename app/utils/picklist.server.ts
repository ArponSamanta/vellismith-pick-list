import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";

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

const ORDERS_PER_PAGE = 250;
const FULFILLMENT_ORDERS_PER_ORDER = 20;
const LINE_ITEMS_PER_FO = 250;
const CONCURRENT_REQUESTS = 3;
const RATE_LIMIT_DELAY = 2000;

export async function generatePickList(
  admin: AdminApiContext,
  options?: PickListOptions
): Promise<PickListProduct[]> {
  try {
    const [unshippedIds, partialIds] = await Promise.all([
      fetchOrderIds(admin, "unshipped", options),
      fetchOrderIds(admin, "partial", options),
    ]);

    const allIds = [...new Set([...unshippedIds, ...partialIds])];
    console.log(`Total orders to process: ${allIds.length}`);

    if (allIds.length === 0) return [];

    const pickList = await fetchFulfillmentData(admin, allIds);
    console.log(`Final pick list: ${pickList.length} products`);
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
  return pickList.filter((p) => p.productTitle.toLowerCase().includes(keyword));
}

export function formatPickListAsText(
  pickList: PickListProduct[],
  options?: { showSku?: boolean; showVariantQuantity?: boolean }
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function getNextDayISO(dateString: string): string {
  const date = new Date(`${dateString}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().split("T")[0];
}

// ─── GraphQL with retry ─────────────────────────────────────────────────────

async function graphqlWithRetry(
  admin: AdminApiContext,
  query: string,
  variables: Record<string, unknown> = {},
  attempt = 0
): Promise<any> {
  try {
    const response: any = await admin.graphql(query, { variables });
    const data: any = await response.json();
    return data;
  } catch (error: any) {
    const isThrottled = error?.message?.includes("Throttled") ||
      error?.response?.status === 429;
    
    if (isThrottled && attempt < 3) {
      const delay = RATE_LIMIT_DELAY * Math.pow(2, attempt);
      console.log(`Throttled, retrying in ${delay}ms (attempt ${attempt + 1})`);
      await sleep(delay);
      return graphqlWithRetry(admin, query, variables, attempt + 1);
    }
    throw error;
  }
}

// ─── Step 1: Fetch order IDs ─────────────────────────────────────────────────

function buildQueryString(status: string, options?: DateRangeOptions): string {
  const conditions = [`fulfillment_status:${status}`];
  if (options?.startDate) conditions.push(`created_at:>="${options.startDate}T00:00:00Z"`);
  if (options?.endDate) conditions.push(`created_at:<"${getNextDayISO(options.endDate)}T00:00:00Z"`);
  return conditions.join(" AND ");
}

async function fetchOrderIds(
  admin: AdminApiContext,
  status: string,
  options?: DateRangeOptions
): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | null = null;
  let hasNextPage = true;
  const queryString = buildQueryString(status, options);
  console.log(`${status} query: ${queryString}`);

  while (hasNextPage) {
    const data = await graphqlWithRetry(
      admin,
      `query($cursor: String, $query: String!) {
        orders(first: ${ORDERS_PER_PAGE}, after: $cursor, query: $query, sortKey: CREATED_AT, reverse: true) {
          pageInfo { hasNextPage, endCursor }
          edges { node { id, createdAt } }
        }
      }`,
      { cursor, query: queryString }
    );

    if (data.errors) {
      console.error(`${status} errors:`, JSON.stringify(data.errors));
      break;
    }
    
    const orders = data.data?.orders;
    if (!orders) {
      console.log(`${status}: no orders data returned`);
      break;
    }

    console.log(`${status}: got ${orders.edges.length} orders on this page`);

    for (const edge of orders.edges) {
      ids.push(edge.node.id);
    }

    hasNextPage = orders.pageInfo.hasNextPage;
    cursor = orders.pageInfo.endCursor;
  }

  console.log(`${status}: found ${ids.length} order IDs`);
  return ids;
}

// ─── Step 2: Fetch fulfillment orders ────────────────────────────────────────

async function fetchFulfillmentData(
  admin: AdminApiContext,
  orderIds: string[]
): Promise<PickListProduct[]> {
  const productMap = new Map<string, PickListProduct>();
  const processedLineItemIds = new Set<string>();
  let processed = 0;

  for (let i = 0; i < orderIds.length; i += CONCURRENT_REQUESTS) {
    const batch = orderIds.slice(i, i + CONCURRENT_REQUESTS);

    const results = await Promise.allSettled(
      batch.map((orderId) =>
        graphqlWithRetry(
          admin,
          `query($orderId: ID!) {
            order(id: $orderId) {
              id
              name
              createdAt
              fulfillmentOrders(first: ${FULFILLMENT_ORDERS_PER_ORDER}) {
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
            }
          }`,
          { orderId }
        )
      )
    );

    for (const result of results) {
      if (result.status === "rejected") continue;

      const order = result.value?.data?.order as {
        id: string;
        name: string;
        createdAt: string;
        fulfillmentOrders?: {
          edges: Array<{
            node: {
              id: string;
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
      } | undefined;

      if (!order?.fulfillmentOrders?.edges) continue;

      for (const foEdge of order.fulfillmentOrders.edges) {
        const fo = foEdge.node;

        if (fo.status !== "OPEN" && fo.status !== "IN_PROGRESS") continue;
        if (!fo.lineItems?.edges) continue;

        for (const { node: li } of fo.lineItems.edges) {
          if (li.remainingQuantity <= 0) continue;

          const v = li.variant;
          if (!v?.product) continue;

          if (processedLineItemIds.has(li.id)) continue;
          processedLineItemIds.add(li.id);

          const p = v.product;
          const key = p.id;

          if (!productMap.has(key)) {
            productMap.set(key, {
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

          const pg = productMap.get(key)!;
          if (order.createdAt < pg.earliestCreatedAt) pg.earliestCreatedAt = order.createdAt;
          if (order.createdAt > pg.latestCreatedAt) pg.latestCreatedAt = order.createdAt;

          let vg = pg.variants.find((x) => x.variantId === v.id);
          if (!vg) {
            vg = { variantId: v.id, variantTitle: v.title, sku: v.sku, quantity: 0, orderNumbers: [] };
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

    processed += batch.length;
    
    if (i + CONCURRENT_REQUESTS < orderIds.length) {
      await sleep(500);
    }
  }

  console.log(`Processed ${processed} orders, ${productMap.size} products`);
  return Array.from(productMap.values());
}

// ─── Sort ────────────────────────────────────────────────────────────────────

function sortPickList(list: PickListProduct[], sortBy: SortBy): PickListProduct[] {
  for (const p of list) {
    p.variants.sort((a, b) => a.variantTitle.toLowerCase().localeCompare(b.variantTitle.toLowerCase()));
  }

  switch (sortBy) {
    case "old-to-new":
      return [...list].sort((a, b) => new Date(a.earliestCreatedAt).getTime() - new Date(b.earliestCreatedAt).getTime());
    case "new-to-old":
      return [...list].sort((a, b) => new Date(b.latestCreatedAt).getTime() - new Date(a.latestCreatedAt).getTime());
    case "qty-high-to-low":
      return [...list].sort((a, b) => b.totalQuantity - a.totalQuantity);
    case "qty-low-to-high":
      return [...list].sort((a, b) => a.totalQuantity - b.totalQuantity);
    case "alpha":
    default:
      return [...list].sort((a, b) => a.productTitle.toLowerCase().localeCompare(b.productTitle.toLowerCase()));
  }
}