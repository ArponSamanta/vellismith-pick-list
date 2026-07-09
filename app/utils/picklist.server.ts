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
const LINE_ITEMS_PER_ORDER = 250;
const ORDERS_PER_BATCH = 5;

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
    if (allIds.length === 0) return [];

    const pickList = await fetchLineItemsBatch(admin, allIds);
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

function getNextDayISO(dateString: string): string {
  const date = new Date(`${dateString}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().split("T")[0];
}

async function graphql(
  admin: AdminApiContext,
  query: string,
  variables: Record<string, unknown> = {}
): Promise<any> {
  return admin.graphql(query, { variables });
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

  while (hasNextPage) {
    const data = await graphql(
      admin,
      `query($cursor: String, $query: String!) {
        orders(first: ${ORDERS_PER_PAGE}, after: $cursor, query: $query, sortKey: CREATED_AT, reverse: true) {
          pageInfo { hasNextPage, endCursor }
          edges { node { id, createdAt } }
        }
      }`,
      { cursor, query: queryString }
    );

    if (data.errors) break;

    const orders = data.data?.orders;
    if (!orders) break;

    for (const edge of orders.edges) {
      const d = edge.node.createdAt;
      if (options?.startDate && d < `${options.startDate}T00:00:00Z`) continue;
      if (options?.endDate && d >= `${getNextDayISO(options.endDate)}T00:00:00Z`) continue;
      ids.push(edge.node.id);
    }

    hasNextPage = orders.pageInfo.hasNextPage;
    cursor = orders.pageInfo.endCursor;
  }

  return ids;
}

// ─── Step 2: Batch fetch line items ──────────────────────────────────────────

function buildBatchQuery(orderIds: string[]): string {
  const fragments = orderIds.map(
    (id, i) => `
    o${i}: order(id: "${id}") {
      id
      name
      createdAt
      lineItems(first: ${LINE_ITEMS_PER_ORDER}) {
        edges {
          node {
            id
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
    }`
  ).join("\n");

  return `query { ${fragments} }`;
}

async function fetchLineItemsBatch(
  admin: AdminApiContext,
  orderIds: string[]
): Promise<PickListProduct[]> {
  const productMap = new Map<string, PickListProduct>();
  const processed = new Set<string>();

  for (let i = 0; i < orderIds.length; i += ORDERS_PER_BATCH) {
    const batch = orderIds.slice(i, i + ORDERS_PER_BATCH);
    const query = buildBatchQuery(batch);
    const data = await graphql(admin, query);

    if (data.errors) continue;

    for (let j = 0; j < batch.length; j++) {
      const orderData = data.data?.[`o${j}`] as {
        id: string;
        name: string;
        createdAt: string;
        lineItems?: {
          edges: Array<{
            node: {
              id: string;
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
      } | undefined;

      if (!orderData?.lineItems?.edges) continue;

      const orderName = orderData.name;
      const orderDate = orderData.createdAt;

      for (const { node: li } of orderData.lineItems.edges) {
        // fulfillableQuantity = 0 for fully fulfilled, cancelled, refunded items
        const qty = li.fulfillableQuantity;
        if (qty <= 0) continue;

        const v = li.variant;
        if (!v?.product) continue;

        if (processed.has(li.id)) continue;
        processed.add(li.id);

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
            earliestCreatedAt: orderDate,
            latestCreatedAt: orderDate,
          });
        }

        const pg = productMap.get(key)!;
        if (orderDate < pg.earliestCreatedAt) pg.earliestCreatedAt = orderDate;
        if (orderDate > pg.latestCreatedAt) pg.latestCreatedAt = orderDate;

        let vg = pg.variants.find((x) => x.variantId === v.id);
        if (!vg) {
          vg = { variantId: v.id, variantTitle: v.title, sku: v.sku, quantity: 0, orderNumbers: [] };
          pg.variants.push(vg);
        }

        vg.quantity += qty;
        pg.totalQuantity += qty;
        if (orderName && !vg.orderNumbers.includes(orderName)) {
          vg.orderNumbers.push(orderName);
        }
      }
    }
  }

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