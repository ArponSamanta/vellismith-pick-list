-- Which of a product's variants a run is filling orders for.
--
-- Purely additive: the default of an empty array means "every variant", which
-- is exactly what every existing run does today, so no row needs backfilling
-- and no behaviour changes for anything already in flight.
--
-- Scopes commitments, not capability. The casting is shared across a product's
-- variants, so the pieces can still become anything; this only says which
-- order lines the run is willing to take on.
ALTER TABLE "BatchProduct" ADD COLUMN "variantIds" TEXT[] DEFAULT ARRAY[]::TEXT[];
