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
    const { orders: allOrders, shopTimezone } = await fetchAllUnfulfilledOrders(admin);
    console.log(`Found ${allOrders.length} unfulfilled orders from API. Shop Timezone: ${shopTimezone}`);

    let orders = allOrders;

    // Bulletproof JS filtering: Converts order's UTC timestamp exactly to the shop's local YYYY-MM-DD date
    if (options?.startDate || options?.endDate) {
      const dateFormatter = new Intl.DateTimeFormat('en-CA', {
        timeZone: shopTimezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
      });

      orders = orders.filter((order) => {
        const localOrderDate = dateFormatter.format(new Date(order.createdAt)); // "YYYY-MM-DD"
        
        if (options.startDate && localOrderDate < options.startDate) return false;
        if (options.endDate && localOrderDate > options.endDate) return false;
        
        return true;
      });
      console.log(`${orders.length} orders remain after local timezone date filter`);
    }

    const pickList = processOrders(orders);
    return sortPickList(pickList, options?.sortBy || "alpha");
  } catch (error) {
    console.error("Error in generatePickList:", error);
    throw error;
  }
}


async function fetchAllUnfulfilledOrders(
  admin: AdminApiContext
): Promise<{ orders: any[]; shopTimezone: string }> {
  let allOrders: any[] = [];
  let hasNextPage = true;
  let cursor: string | null = null;
  let shopTimezone = "UTC"; // Default fallback

  while (hasNextPage) {
    console.log("Fetching orders with cursor:", cursor);
    
    const response: any = await admin.graphql(
      `#graphql
      query GetUnfulfilledOrders($cursor: String) {
        shop {
          ianaTimezone
        }
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
    
    // Extract timezone from the first page
    if (data.data?.shop?.ianaTimezone) {
      shopTimezone = data.data.shop.ianaTimezone;
    }
    
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

  return { orders: allOrders, shopTimezone };
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