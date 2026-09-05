/**
 * Catalogue search for the batch builder (resource route — no component).
 *
 * Hit as the merchant types, so it stays deliberately small: one live Shopify
 * query, no caching, no order data. The rest of the batches page never calls
 * it — searching products only costs anything while somebody is actually
 * picking what a run will make.
 */

import type { LoaderFunctionArgs, ShouldRevalidateFunction } from "react-router";

import { authenticate } from "../shopify.server";
import { searchVariants, type CatalogVariant } from "../utils/catalog.server";

export const shouldRevalidate: ShouldRevalidateFunction = () => false;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);

  const params = new URL(request.url).searchParams;
  const term = params.get("q") ?? "";
  // Scoped to one product for the plating handler, which has to offer every
  // finish the product can take — not only the ones somebody ordered.
  const productId = params.get("productId") ?? undefined;

  try {
    const variants = await searchVariants(admin, term, productId);
    return { variants, error: null as string | null };
  } catch (error) {
    console.error("[batch] product search error:", error);
    return {
      variants: [] as CatalogVariant[],
      error: "Couldn't search products. The app may need re-authorising.",
    };
  }
};
