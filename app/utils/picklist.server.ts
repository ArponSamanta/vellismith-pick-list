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
  console.log("========== GENERATE PICK LIST ==========");
  console.log("options:", JSON.stringify(options, null, 2));
  try {
    console.log("Passing to fetchAllUnfulfilledOrders:", {
      startDate: options?.startDate,
      endDate: options?.endDate,
    });
    let orders = await fetchAllUnfulfilledOrders(admin, {
      startDate: options?.startDate,
      endDate: options?.endDate,
    });
    console.log(`Found ${orders.length} unfulfilled orders from API`);

    if (options?.startDate || options?.endDate) {
      orders = filterOrdersByDateRange(orders, options.startDate, options.endDate);
      console.log(`${orders.length} orders remain after strict date range filter`);
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
    if (startDate) {
      if (order.createdAt < startDate) return false;
    }
    
    if (endDate) {
      const endDateObj = new Date(endDate + "T00:00:00Z");
      endDateObj.setUTCDate(endDateObj.getUTCDate() + 1);
      const nextDay = endDateObj.toISOString().split("T")[0];
      
      if (order.createdAt >= nextDay) return false;
    }

    return true;
  });
}

async function fetchAllUnfulfilledOrders(
  admin: AdminApiContext,
  options?: {
    startDate?: string;
    endDate?: string;
  }
): Promise<any[]> {
  console.log("========== FETCH ORDERS ==========");
  console.log("options received:", JSON.stringify(options, null, 2));
  let allOrders: any[] = [];
  let hasNextPage = true;
  let cursor: string | null = null;

  const queryParts = ["fulfillment_status:unshipped"];
  if (options?.startDate) {
    queryParts.push(`created_at:>="${options.startDate}"`);
  }
  if (options?.endDate) {
    const endDateObj = new Date(options.endDate + "T00:00:00Z");
    endDateObj.setUTCDate(endDateObj.getUTCDate() + 1);
    const nextDay = endDateObj.toISOString().split("T")[0];
    queryParts.push(`created_at:<"${nextDay}"`);
  }
  console.log("queryParts before join:", queryParts);
  const queryString = queryParts.join(" AND ");
  console.log("Shopify orders query:", queryString);

  while (hasNextPage) {
    console.log("Fetching orders with cursor:", cursor);
    
    const graphqlResponse: any = await admin.graphql(
      `#graphql
      query GetUnfulfilledOrders($cursor: String, $query: String!) {
        orders(first: 250, after: $cursor, query: $query) {
          pageInfo {
            hasNextPage
            endCursor
          }
          edges {
            node {
              id
              name
              createdAt
              fulfillmentOrders(first: 50) {
                edges {
                  node {
                    id
                    status
                    lineItems(first: 50) {
                      edges {
                        node {
                          id
                          remainingQuantity
                          totalQuantity
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
          }
        }
      }`,
      {
        variables: { cursor, query: queryString },
      }
    );

    console.log("GraphQL response - has errors?", !!graphqlResponse.errors);
    console.log("GraphQL response - has orders?", !!graphqlResponse.data?.orders);

    if (graphqlResponse.errors) {
      console.error("GraphQL errors:", graphqlResponse.errors);
      throw new Error(`GraphQL error: ${graphqlResponse.errors[0].message}`);
    }

    if (!graphqlResponse.data?.orders) {
      console.error("No orders data in response");
      throw new Error("Failed to fetch orders from Shopify");
    }

    const ordersData: any = graphqlResponse.data.orders;
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
    const fulfillmentOrders = order.fulfillmentOrders?.edges;
    if (!fulfillmentOrders?.length) {
      console.log("Order has no fulfillment orders:", order.name);
      return;
    }

    fulfillmentOrders.forEach(({ node: fulfillmentOrder }: any) => {
      if (fulfillmentOrder.status !== "OPEN") {
        console.log(
          `Skipping fulfillment order ${fulfillmentOrder.id} - status: ${fulfillmentOrder.status}`
        );
        return;
      }

      const lineItems = fulfillmentOrder.lineItems?.edges;
      if (!lineItems?.length) {
        console.log("Fulfillment order has no line items:", fulfillmentOrder.id);
        return;
      }

      lineItems.forEach(({ node: fulfillmentLineItem }: any) => {
        const remainingQty = fulfillmentLineItem.remainingQuantity;

        if (remainingQty <= 0) {
          console.log(
            `Skipping ${fulfillmentLineItem.variant?.title} - remainingQuantity: ${remainingQty}`
          );
          return;
        }

        const variant = fulfillmentLineItem.variant;
        const product = variant?.product;

        if (!product) {
          console.log("Fulfillment line item has no product:", fulfillmentLineItem.id);
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

        if (order.createdAt < productGroup.earliestCreatedAt) {
          productGroup.earliestCreatedAt = order.createdAt;
        }
        if (order.createdAt > productGroup.latestCreatedAt) {
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
            orderNumbers: [] as string[],
          };
          productGroup.variants.push(variantGroup);
        }

        variantGroup.quantity += remainingQty;
        productGroup.totalQuantity += remainingQty;

        if (order.name && !variantGroup.orderNumbers.includes(order.name)) {
          variantGroup.orderNumbers.push(order.name);
        }
      });
    });
  });

  console.log(`Processed ${productMap.size} unique products`);
  return Array.from(productMap.values());
}

function sortPickList(pickList: any[], sortBy: SortBy): any[] {
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