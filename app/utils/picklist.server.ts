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

const ORDERS_PER_PAGE = 250;
const RATE_LIMIT_BASE_DELAY = 1000;

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
    const [unshippedProducts, partialProducts] = await Promise.all([
      fetchPickListByStatus(admin, "unshipped", options),
      fetchPickListByStatus(admin, "partial", options),
    ]);

    const productMap = new Map<string, PickListProduct>();
    for (const product of [...unshippedProducts, ...partialProducts]) {
      const existing = productMap.get(product.productId);
      if (existing) {
        for (const v of product.variants) {
          const ev = existing.variants.find((x) => x.variantId === v.variantId);
          if (ev) {
            ev.quantity += v.quantity;
            for (const on of v.orderNumbers) {
              if (!ev.orderNumbers.includes(on)) ev.orderNumbers.push(on);
            }
          } else {
            existing.variants.push(v);
          }
        }
        existing.totalQuantity += product.totalQuantity;
        if (product.earliestCreatedAt < existing.earliestCreatedAt) {
          existing.earliestCreatedAt = product.earliestCreatedAt;
        }
        if (product.latestCreatedAt > existing.latestCreatedAt) {
          existing.latestCreatedAt = product.latestCreatedAt;
        }
      } else {
        productMap.set(product.productId, product);
      }
    }

    const pickList = Array.from(productMap.values());

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

// ─── GraphQL Helper ──────────────────────────────────────────────────────────

async function graphqlWithRetry(
  admin: AdminApiContext,
  query: string,
  variables: Record<string, unknown>,
  attempt = 0
): Promise<any> {
  const MAX_RETRIES = 3;

  try {
    const response: any = await admin.graphql(query, { variables });
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
    if (attempt < MAX_RETRIES) {
      await sleep(RATE_LIMIT_BASE_DELAY * Math.pow(2, attempt));
      return graphqlWithRetry(admin, query, variables, attempt + 1);
    }
    throw error;
  }
}

// ─── Fetch ───────────────────────────────────────────────────────────────────

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

async function fetchPickListByStatus(
  admin: AdminApiContext,
  status: "unshipped" | "partial",
  options?: DateRangeOptions
): Promise<PickListProduct[]> {
  const productMap = new Map<string, PickListProduct>();
  const processedLineItemIds = new Set<string>();
  let hasNextPage = true;
  let cursor: string | null = null;
  const queryString = buildQueryString(status, options);

  while (hasNextPage) {
    const data = await graphqlWithRetry(
      admin,
      `query GetOrders($cursor: String, $query: String!) {
        orders(
          first: ${ORDERS_PER_PAGE},
          after: $cursor,
          query: $query,
          sortKey: CREATED_AT,
          reverse: true
        ) {
          pageInfo { hasNextPage, endCursor }
          edges {
            node {
              id
              name
              createdAt
              lineItems(first: 250) {
                edges {
                  node {
                    id
                    quantity
                    fulfillableQuantity
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
      }`,
      { cursor, query: queryString }
    );

    if (data.errors) {
      console.error(`GraphQL errors (${status}):`, data.errors);
      throw new Error(`GraphQL error: ${data.errors[0].message}`);
    }

    const orders = data.data?.orders as {
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      edges: Array<{
        node: {
          id: string;
          name: string;
          createdAt: string;
          lineItems: {
            edges: Array<{
              node: {
                id: string;
                quantity: number;
                fulfillableQuantity: number;
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
    } | undefined;

    if (!orders) break;

    for (const orderEdge of orders.edges) {
      const order = orderEdge.node;
      const orderName = order.name;
      const orderDate = order.createdAt;

      if (options?.startDate && orderDate < `${options.startDate}T00:00:00Z`) continue;
      if (options?.endDate && orderDate >= `${getNextDayISO(options.endDate)}T00:00:00Z`) continue;

      if (!order.lineItems?.edges) continue;

      for (const { node: lineItem } of order.lineItems.edges) {
        // fulfillableQuantity is the quantity available to fulfill.
        // For unfulfilled orders: equals quantity.
        // For partially fulfilled orders: equals remaining quantity.
        // Returns 0 for fully fulfilled or refunded line items.
        const qty = lineItem.fulfillableQuantity ?? lineItem.quantity;
        if (qty <= 0) continue;

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
            earliestCreatedAt: orderDate,
            latestCreatedAt: orderDate,
          });
        }

        const pg = productMap.get(productKey)!;

        if (orderDate < pg.earliestCreatedAt) pg.earliestCreatedAt = orderDate;
        if (orderDate > pg.latestCreatedAt) pg.latestCreatedAt = orderDate;

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

        vg.quantity += qty;
        pg.totalQuantity += qty;

        if (orderName && !vg.orderNumbers.includes(orderName)) {
          vg.orderNumbers.push(orderName);
        }
      }
    }

    hasNextPage = orders.pageInfo.hasNextPage;
    cursor = orders.pageInfo.endCursor;
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