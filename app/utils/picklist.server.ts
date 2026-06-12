import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";

export type SortBy =
  | "alpha"
  | "old-to-new"
  | "new-to-old"
  | "qty-high-to-low"
  | "qty-low-to-high";

export async function generatePickList(
  admin: AdminApiContext,
  options?: {
    startDate?: string;
    endDate?: string;
    sortBy?: SortBy;
  }
) {
  try {
    let orders = await fetchAllUnfulfilledOrders(admin);
    console.log(`Found ${orders.length} unfulfilled orders`);

    // Filter orders by date range BEFORE aggregation so quantities are correct
    if (options?.startDate || options?.endDate) {
      orders = filterOrdersByDateRange(
        orders,
        options.startDate,
        options.endDate
      );
      console.log(`${orders.length} orders remain after date range filter`);
    }

    const pickList = processOrders(orders);
    return sortPickList(pickList, options?.sortBy || "alpha");
  } catch (error) {
    console.error("Error in generatePickList:", error);
    throw error;
  }
}

function filterOrdersByDateRange(
  orders: any[],
  startDate?: string,
  endDate?: string
): any[] {
  return orders.filter((order) => {
    const orderDate = new Date(order.createdAt);

    if (startDate) {
      const start = new Date(startDate);
      start.setHours(0, 0, 0, 0);
      if (orderDate < start) return false;
    }

    if (endDate) {
      const end = new Date(endDate);
      end.setHours(23, 59, 59, 999);
      if (orderDate > end) return false;
    }

    return true;
  });
}

async function fetchAllUnfulfilledOrders(admin: AdminApiContext) {
  let allOrders: any[] = [];
  let hasNextPage = true;
  let cursor: string | null = null;

  while (hasNextPage) {
    console.log("Fetching orders with cursor:", cursor);
    
    const response: any = await admin.graphql(
      `#graphql
      query GetUnfulfilledOrders($cursor: String) {
        orders(
          first: 250,
          after: $cursor,
          query: "fulfillment_status:unshipped"
        ) {
          pageInfo {
            hasNextPage
            endCursor
          }
          edges {
            node {
              id
              createdAt
              lineItems(first: 250) {
                edges {
                  node {
                    id
                    quantity
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
      }`,
      {
        variables: { cursor },
      }
    );

    const data = await response.json();
    console.log("Response data:", JSON.stringify(data, null, 2).substring(0, 500));
    
    if (data.errors) {
      console.error("GraphQL errors:", data.errors);
      throw new Error(`GraphQL error: ${data.errors[0].message}`);
    }
    
    if (!data.data?.orders) {
      console.error("No orders data in response");
      throw new Error("Failed to fetch orders from Shopify");
    }
    
    const ordersData = data.data.orders;
    allOrders.push(...ordersData.edges.map((edge: any) => edge.node));

    hasNextPage = ordersData.pageInfo.hasNextPage;
    cursor = ordersData.pageInfo.endCursor;
  }

  return allOrders;
}

function processOrders(orders: any[]): any[] {
  console.log(`Processing ${orders.length} orders`);

  const productMap = new Map<string, any>();

  orders.forEach((order) => {
    if (!order.lineItems?.edges) {
      console.log("Order has no line items:", order.id);
      return;
    }

    order.lineItems.edges.forEach(({ node: lineItem }: any) => {
      const variant = lineItem.variant;
      const product = variant?.product;

      if (!product) {
        console.log("Line item has no product:", lineItem.id);
        return;
      }

      const productKey = product.id;

      if (!productMap.has(productKey)) {
        productMap.set(productKey, {
          productId: product.id,
          productTitle: product.title,
          productType: product.productType,
          productImage: product.featuredImage,
          variants: [],
          totalQuantity: 0,
          earliestCreatedAt: order.createdAt,
          latestCreatedAt: order.createdAt,
        });
      }

      const productGroup = productMap.get(productKey)!;

      // Track earliest and latest order dates for this product
      if (new Date(order.createdAt) < new Date(productGroup.earliestCreatedAt)) {
        productGroup.earliestCreatedAt = order.createdAt;
      }
      if (new Date(order.createdAt) > new Date(productGroup.latestCreatedAt)) {
        productGroup.latestCreatedAt = order.createdAt;
      }

      let variantGroup = productGroup.variants.find(
        (v: any) => v.variantId === variant.id
      );

      if (!variantGroup) {
        variantGroup = {
          variantId: variant.id,
          variantTitle: variant.title,
          sku: variant.sku,
          quantity: 0,
        };
        productGroup.variants.push(variantGroup);
      }

      variantGroup.quantity += lineItem.quantity;
      productGroup.totalQuantity += lineItem.quantity;
    });
  });

  return Array.from(productMap.values());
}

function sortPickList(pickList: any[], sortBy: SortBy): any[] {
  // Always sort variants alphabetically within each product
  pickList.forEach((product) => {
    product.variants.sort((va: any, vb: any) => {
      const variantA = va.variantTitle.toLowerCase();
      const variantB = vb.variantTitle.toLowerCase();
      if (variantA < variantB) return -1;
      if (variantA > variantB) return 1;
      return 0;
    });
  });

  switch (sortBy) {
    case "old-to-new":
      return pickList.sort(
        (a, b) =>
          new Date(a.earliestCreatedAt).getTime() -
          new Date(b.earliestCreatedAt).getTime()
      );

    case "new-to-old":
      return pickList.sort(
        (a, b) =>
          new Date(b.latestCreatedAt).getTime() -
          new Date(a.latestCreatedAt).getTime()
      );

    case "qty-high-to-low":
      return pickList.sort((a, b) => b.totalQuantity - a.totalQuantity);

    case "qty-low-to-high":
      return pickList.sort((a, b) => a.totalQuantity - b.totalQuantity);

    case "alpha":
    default:
      return pickList.sort((a, b) => {
        const nameA = a.productTitle.toLowerCase();
        const nameB = b.productTitle.toLowerCase();
        if (nameA < nameB) return -1;
        if (nameA > nameB) return 1;
        return 0;
      });
  }
}

export function filterByProductName(
  pickList: any[],
  searchKeyword?: string
): any[] {
  if (!searchKeyword || searchKeyword.trim() === "") return pickList;

  const keyword = searchKeyword.toLowerCase();
  return pickList.filter((product) =>
    product.productTitle.toLowerCase().includes(keyword)
  );
}

export function formatPickListAsText(
  pickList: any[],
  options?: {
    showSku?: boolean;
    showVariantQuantity?: boolean;
  }
): string {
  const showSku = options?.showSku ?? true;
  const showVariantQuantity = options?.showVariantQuantity ?? true;

  const header = `
========================================
          PICKING LIST - UNFULFILLED
          Date: ${new Date().toLocaleDateString()}
========================================

`;

  let body = "";
  pickList.forEach((product: any) => {
    body += `
┌─────────────────────────────────────┐
│ PRODUCT: ${product.productTitle.padEnd(30)} │
│ Total Qty to Pick: ${product.totalQuantity.toString().padEnd(21)} │
└─────────────────────────────────────┘
`;

    if (showVariantQuantity) {
      product.variants.forEach((variant: any) => {
        const skuPart = showSku && variant.sku ? ` (SKU: ${variant.sku})` : "";
        body += `\n  Variant: ${variant.variantTitle}${skuPart}`;
        body += `\n  Quantity Needed: ${variant.quantity}`;
        body += "\n" + "-".repeat(50) + "\n";
      });
    }
  });

  const totalItems = pickList.reduce((sum: number, p: any) => sum + p.totalQuantity, 0);
  const footer = `
========================================
  Total Products: ${pickList.length}
  Total Items: ${totalItems}
========================================
`;

  return header + body + footer;
}