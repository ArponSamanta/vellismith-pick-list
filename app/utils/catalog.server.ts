/**
 * Product catalogue lookup for the batch builder.
 *
 * A run is not limited to what customers have already ordered — the workshop
 * decides to cast a design because it is worth casting, and half the point of
 * a batch is producing stock nobody has asked for yet. So the builder needs
 * every variant in the store, not just the ones with outstanding lines.
 *
 * This is deliberately separate from picklist.server: that file exists to
 * sweep ORDERS, which is expensive and cached. This is a cheap, live,
 * user-typed search against products, and caching it would only serve stale
 * titles while somebody is picking from a list.
 */

import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";

export interface CatalogVariant {
  variantId: string;
  productId: string;
  productTitle: string;
  variantTitle: string;
  sku: string | null;
  imageUrl: string | null;
}

/** Enough to scroll, few enough to stay well inside the query cost budget. */
const SEARCH_LIMIT = 40;

const SEARCH_QUERY = `
  query BatchVariantSearch($q: String, $first: Int!) {
    productVariants(first: $first, query: $q) {
      edges {
        node {
          id
          title
          sku
          image { url }
          product { id title status featuredImage { url } }
        }
      }
    }
  }
`;

const BY_ID_QUERY = `
  query BatchVariantsById($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on ProductVariant {
        id
        title
        sku
        image { url }
        product { id title featuredImage { url } }
      }
    }
  }
`;

/**
 * Search every variant in the store.
 *
 * Archived products are filtered out: they are not things the workshop should
 * be starting a production run for, and leaving them in the list is an easy
 * way to cast fifty of something that was discontinued.
 */
export async function searchVariants(
  admin: AdminApiContext,
  term: string,
  productId?: string
): Promise<CatalogVariant[]> {
  const trimmed = term.trim();

  // Every variant of ONE product — what the plating handler needs, because a
  // finish nobody has ordered yet still has to be allocatable. Shopify's
  // search takes the numeric id, not the GID.
  const scoped = productId ? `product_id:${productId.split("/").pop()}` : null;

  const response: any = await admin.graphql(SEARCH_QUERY, {
    variables: {
      // An empty query returns the first page of the catalogue, which is what
      // the builder shows before anyone types.
      q: scoped ?? (trimmed === "" ? null : trimmed),
      first: SEARCH_LIMIT,
    },
  });
  const data: any = await response.json();

  if (Array.isArray(data?.errors) && data.errors.length > 0) {
    console.error("[batch] variant search errors:", data.errors);
    throw new Error("Couldn't search products.");
  }

  const out: CatalogVariant[] = [];
  for (const edge of data?.data?.productVariants?.edges ?? []) {
    const node = edge?.node;
    if (!node?.id || !node.product?.id) continue;
    if (node.product.status === "ARCHIVED") continue;
    out.push(toCatalogVariant(node));
  }
  return out;
}

/**
 * Identity for a known set of variants, for snapshotting into a run.
 *
 * Used when a picked variant has no outstanding orders, so there is no order
 * line to copy the product's title and image from.
 */
export async function fetchVariants(
  admin: AdminApiContext,
  variantIds: string[]
): Promise<Map<string, CatalogVariant>> {
  const found = new Map<string, CatalogVariant>();
  if (variantIds.length === 0) return found;

  // Same chunk size as the inventory read, and for the same reason: a run can
  // hold many variants and the query cost scales with them.
  for (let i = 0; i < variantIds.length; i += SEARCH_LIMIT) {
    const chunk = variantIds.slice(i, i + SEARCH_LIMIT);

    const response: any = await admin.graphql(BY_ID_QUERY, {
      variables: { ids: chunk },
    });
    const data: any = await response.json();

    if (Array.isArray(data?.errors) && data.errors.length > 0) {
      console.error("[batch] variant lookup errors:", data.errors);
      throw new Error("Couldn't read those products from Shopify.");
    }

    for (const node of data?.data?.nodes ?? []) {
      if (!node?.id || !node.product?.id) continue;
      found.set(node.id, toCatalogVariant(node));
    }
  }

  return found;
}

/**
 * The shape this module reads out of a variant node.
 *
 * Deliberately narrower than Shopify's ProductVariant: every field the two
 * queries select and nothing more, so a query that stops returning one of them
 * fails here at compile time rather than as a silently blank title.
 */
interface VariantNode {
  id: string;
  title?: string | null;
  sku?: string | null;
  image?: { url?: string | null } | null;
  product: {
    id: string;
    title?: string | null;
    status?: string | null;
    featuredImage?: { url?: string | null } | null;
  };
}

function toCatalogVariant(node: VariantNode): CatalogVariant {
  return {
    variantId: node.id,
    productId: node.product.id,
    productTitle: node.product.title ?? "Untitled product",
    // Shopify uses "Default Title" for single-variant products; showing it
    // verbatim reads as a mistake, so let the product title stand alone.
    variantTitle: node.title === "Default Title" ? "" : (node.title ?? ""),
    sku: node.sku || null,
    // The variant's own image when it has one, else the product's.
    imageUrl: node.image?.url ?? node.product.featuredImage?.url ?? null,
  };
}
