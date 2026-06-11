import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";

export async function generatePickList(admin: AdminApiContext) {
  try {
    const orders = await fetchAllUnfulfilledOrders(admin);
    console.log(`Found ${orders.length} unfulfilled orders`);

    const pickList = processOrders(orders);
    return sortPickList(pickList);
  } catch (error) {
    console.error("Error in generatePickList:", error);
    throw error;
  }
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
          createdAt: order.createdAt,
        });
      }

      const productGroup = productMap.get(productKey)!;

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

function sortPickList(pickList: any[]): any[] {
  return pickList.sort((a, b) => {
    const nameA = a.productTitle.toLowerCase();
    const nameB = b.productTitle.toLowerCase();

    if (nameA < nameB) return -1;
    if (nameA > nameB) return 1;

    a.variants.sort((va: any, vb: any) => {
      const variantA = va.variantTitle.toLowerCase();
      const variantB = vb.variantTitle.toLowerCase();
      if (variantA < variantB) return -1;
      if (variantA > variantB) return 1;
      return 0;
    });

    return 0;
  });
}

export function filterByDateRange(
  pickList: any[],
  startDate?: string,
  endDate?: string
): any[] {
  if (!startDate && !endDate) return pickList;

  return pickList.filter((product) => {
    const productDate = new Date(product.createdAt);

    if (startDate) {
      const start = new Date(startDate);
      start.setHours(0, 0, 0, 0);
      if (productDate < start) return false;
    }

    if (endDate) {
      const end = new Date(endDate);
      end.setHours(23, 59, 59, 999);
      if (productDate > end) return false;
    }

    return true;
  });
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

export function formatPickListAsText(pickList: any[]): string {
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

    product.variants.forEach((variant: any) => {
      body += `\n  Variant: ${variant.variantTitle}${variant.sku ? ` (SKU: ${variant.sku})` : ""}`;
      body += `\n  Quantity Needed: ${variant.quantity}`;
      body += "\n" + "-".repeat(50) + "\n";
    });
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