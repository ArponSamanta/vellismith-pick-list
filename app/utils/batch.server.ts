/**
 * Manufacturing batch data layer.
 *
 * A batch is one production RUN — a casting tree, a polishing load — and its
 * unit is the PRODUCT, not the variant:
 *
 *   Batch "Casting 14 Sep"                    stage: CASTING
 *     └─ BatchProduct  Aurora Ring · 20 raw   splits at PLATING
 *          ├─ BatchItem   #3205 wants Gold, #3211 wants Silver, …
 *          ├─ BatchScrap  3 lost at Casting — raw, no finish
 *          └─ BatchFinish Gold ×8 · Silver ×12   ← reallocated at the split
 *
 * ── Two things that look like one and are not ─────────────────────────────
 * The split decision and the movement of order lines are separate mechanisms,
 * and keeping them separate is what makes this tractable:
 *
 *   • WHERE A PIECE IS follows its own variant's route. A silver line, when
 *     the run reaches Plating, is finished — because silver skips Plating.
 *     That falls out of variantPosition() with no split decision at all.
 *
 *   • HOW MANY PIECES GET EACH FINISH is a quantity decision, made at the
 *     split stage, and it only matters to inventory. Nothing about the board
 *     depends on it.
 *
 * So the plating handler allocates numbers; the tracker follows routes. They
 * meet only at the stock write, which refuses to run while a product's
 * allocation doesn't match what survived.
 *
 * Everything the page DISPLAYS is joined live: committed is recomputed from
 * the current outstanding lines every read, so a cancelled order drops out of
 * the arithmetic honestly. The stored snapshots exist so a CLOSED run still
 * reads correctly long after its lines have left Shopify.
 */

import db from "../db.server";
import { fetchVariants } from "./catalog.server";
import type { OrderLine } from "./picklist.server";
import { fetchGrantedScopes } from "./picklist.server";
import { getBoard, setStatus, type TrackedLine } from "./tracker.server";
import {
  LIVE_BATCH_STATUSES,
  SCRAP_NOTE_MAX,
  cleanBatchName,
  cleanBatchNote,
  cleanPlannedQuantity,
  isBatchStatus,
  madeQuantity,
  nextBatchStep,
  nextRunSequence,
  prevBatchStep,
  runName,
  shortfallOf,
  stageSpread,
  surplusOf,
  variantPosition,
  type BatchStatus,
} from "./batching";
import {
  STAGES,
  UNTRIAGED,
  isStage,
  type BoardColumn,
  type TrackStage,
} from "./tracking";
import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";

export class BatchError extends Error {}

/** Statuses that still hold their member lines, keeping them out of candidates. */
const CLAIMING_STATUSES: string[] = [...LIVE_BATCH_STATUSES];

/** A variant's remembered path, as a lookup. */
export type RouteMap = Map<string, string[]>;

const routeFor = (routes: RouteMap, variantId: string): string[] =>
  routes.get(variantId) ?? [];

// ── Read models ───────────────────────────────────────────────────────────

export interface BatchLineView {
  lineItemId: string;
  orderId: string;
  orderName: string;
  /** The finish this order actually wants. */
  variantId: string;
  variantTitle: string;
  snapshotQuantity: number;
  liveQuantity: number | null;
  changed: boolean;
  column: BoardColumn | null;
  promisedDate: string | null;
}

export interface ScrapView {
  id: string;
  quantity: number;
  stage: string | null;
  variantId: string | null;
  note: string | null;
  createdAt: string;
}

/** One finish a product's pieces can carry. */
export interface FinishView {
  id: string;
  variantId: string;
  variantTitle: string;
  sku: string | null;
  /** Pieces allocated to this finish. */
  quantity: number;
  /** Live demand for THIS finish among the product's order lines. */
  committed: number;
  /** Stages this finish still has to go through after the split. */
  remainingStages: TrackStage[];
  /** True when it is finished as soon as the run reaches the split stage. */
  doneAtSplit: boolean;
  inventoryDelta: number | null;
}

export interface BatchProductView {
  id: string;
  productId: string;
  productTitle: string;
  imageUrl: string | null;

  /** Raw pieces the run makes — the casting number. */
  plannedQuantity: number;
  scrapped: number;
  /** What will actually exist: raw − scrapped. */
  made: number;
  /** Sum across finishes. Must equal `made` before stock can be written. */
  allocated: number;
  reconciled: boolean;

  committed: number;
  surplus: number;
  shortfall: number;

  splitStage: TrackStage | null;
  splitDecidedAt: string | null;
  /** The run has reached the split stage and nobody has allocated yet. */
  splitDue: boolean;

  finishes: FinishView[];
  lines: BatchLineView[];
  scraps: ScrapView[];

  closedLines: number;
  changedLines: number;
  unclaimedLines: number;
  unclaimedPieces: number;
  earliestPromised: string | null;
}

export interface BatchView {
  id: string;
  name: string;
  status: BatchStatus;
  stage: TrackStage | null;
  note: string | null;

  products: BatchProductView[];
  plannedTotal: number;
  madeTotal: number;
  scrappedTotal: number;
  committedTotal: number;
  surplusTotal: number;
  shortfallTotal: number;

  /** Products whose allocation doesn't match what survived. */
  unreconciled: number;
  /** Products waiting on a split decision. */
  splitsDue: number;

  neededStages: TrackStage[];
  earliestPromised: string | null;

  totalLines: number;
  closedLines: number;
  changedLines: number;
  allClosed: boolean;

  spread: Array<[BoardColumn, number]>;
  inStep: boolean;

  inventorySyncedAt: string | null;
  inventoryLocation: string | null;

  createdAt: string;
  updatedAt: string;
}

/** Outstanding work that still needs making, grouped by PRODUCT. */
export interface CandidateVariant {
  variantId: string;
  variantTitle: string;
  sku: string | null;
  pieces: number;
}

export interface BatchCandidate {
  productId: string;
  productTitle: string;
  productType: string;
  imageUrl: string | null;
  /** Total pieces to make across every finish. Excludes ready-to-ship. */
  pieces: number;
  readyPieces: number;
  variants: CandidateVariant[];
  lines: Array<{
    lineItemId: string;
    orderId: string;
    orderName: string;
    variantId: string;
    quantity: number;
    promisedDate: string | null;
    column: BoardColumn;
  }>;
  earliestPromised: string | null;
}

/** An unbatched order a live run could fill from pieces it already has spare. */
export interface AllocationSuggestion {
  lineItemId: string;
  orderName: string;
  quantity: number;
  productTitle: string;
  variantTitle: string;
  promisedDate: string | null;
  batchId: string;
  batchName: string;
  batchProductId: string;
  /** Where that run has got to, for the preview. */
  batchStage: TrackStage | null;
  /** Spare pieces left in that run once this order is taken. */
  spareAfter: number;
}

export interface BatchPageData {
  batches: BatchView[];
  candidates: BatchCandidate[];
  /** Orders that could be filled from surplus without making anything new. */
  suggestions: AllocationSuggestion[];
  readyToShipPieces: number;
  /** What the builder should pre-fill as the next run's name. */
  nextRunName: string;
  fetchedAt: string;
  cached: boolean;
  canWriteInventory: boolean;
}

// ── The page ──────────────────────────────────────────────────────────────

export async function getBatchPage(
  admin: AdminApiContext,
  shop: string,
  opts: { force?: boolean } = {}
): Promise<BatchPageData> {
  const [{ lines, fetchedAt, cached }, rows, routes, grantedScopes] =
    await Promise.all([
      getBoard(admin, shop, opts),
      db.batch.findMany({
        where: { shop, status: { not: "CANCELLED" } },
        include: {
          products: { include: { finishes: true, items: true, scraps: true } },
        },
        orderBy: { createdAt: "desc" },
      }),
      loadRoutes(shop),
      fetchGrantedScopes(admin).catch(() => [] as string[]),
    ]);

  const byLineItem = new Map(lines.map((l) => [l.lineItemId, l]));

  const claimed = new Set<string>();
  for (const row of rows) {
    if (!CLAIMING_STATUSES.includes(row.status)) continue;
    for (const product of row.products) {
      for (const item of product.items) claimed.add(item.lineItemId);
    }
  }

  const candidates = buildCandidates(lines, claimed);
  const byProduct = new Map(candidates.map((c) => [c.productId, c]));
  const batches = rows.map((row) =>
    toBatchView(row, byLineItem, byProduct, routes)
  );

  return {
    batches,
    candidates,
    suggestions: planAllocation(batches, candidates),
    readyToShipPieces: candidates.reduce((sum, c) => sum + c.readyPieces, 0),
    nextRunName: await nextRunName(shop),
    fetchedAt,
    cached,
    canWriteInventory: grantedScopes.includes("write_inventory"),
  };
}

/**
 * Match unbatched orders to runs that already have spare pieces for them.
 *
 * A run making twenty when seven are owed has thirteen going to stock. If an
 * order for that product arrives while the run is still open, it can simply be
 * taken from those thirteen — no new run, no extra casting, and the customer
 * is served from work already at Polishing rather than starting again.
 *
 * ── What "spare" means depends on where the run is ────────────────────────
 * Before the split the surplus is RAW: any spare piece can become any finish,
 * so a gold order and a silver one draw from the same pool. After the split
 * each finish owns its own pieces, and a gold order can only take gold spare.
 * That distinction is the whole reason the split is deferred, and it is what
 * makes this safe to do automatically.
 *
 * Runs are offered furthest-along first, so an order goes to the tray that
 * will finish soonest. Capacity is decremented as matches are made, so two
 * orders can't be promised the same piece.
 *
 * Purely a proposal — nothing here writes. See autoAllocate.
 */
function planAllocation(
  batches: BatchView[],
  candidates: BatchCandidate[]
): AllocationSuggestion[] {
  // Only runs still in production, and not ones whose stock is already
  // written — past that point Shopify's own committed accounting fills a new
  // order from the stock the run produced.
  const open = batches
    .filter((b) => b.status === "OPEN" && !b.inventorySyncedAt)
    .sort(
      (a, b) =>
        (b.stage ? STAGES.indexOf(b.stage) : -1) -
        (a.stage ? STAGES.indexOf(a.stage) : -1)
    );

  // Remaining capacity, decremented as the plan is built.
  const productSpare = new Map<string, number>();
  const finishSpare = new Map<string, number>();
  for (const batch of open) {
    for (const product of batch.products) {
      productSpare.set(`${batch.id}:${product.id}`, product.surplus);
      for (const finish of product.finishes) {
        finishSpare.set(
          `${batch.id}:${product.id}:${finish.variantId}`,
          Math.max(0, finish.quantity - finish.committed)
        );
      }
    }
  }

  const suggestions: AllocationSuggestion[] = [];

  for (const candidate of candidates) {
    // Soonest promised first — if spare pieces are scarce they should go to
    // whoever is waiting on the nearest date.
    const lines = [...candidate.lines].sort((a, b) =>
      (a.promisedDate ?? "9999-12-31").localeCompare(b.promisedDate ?? "9999-12-31")
    );

    for (const line of lines) {
      for (const batch of open) {
        const product = batch.products.find(
          (p) => p.productId === candidate.productId
        );
        if (!product) continue;

        // Before the split, spare is raw and any finish may draw on it. After
        // it, the pieces are already committed to a finish.
        const split = Boolean(product.splitDecidedAt);
        const key = split
          ? `${batch.id}:${product.id}:${line.variantId}`
          : `${batch.id}:${product.id}`;
        const pool = split ? finishSpare : productSpare;

        const spare = pool.get(key) ?? 0;
        // A line is taken whole or not at all — a BatchItem can't hold half
        // an order.
        if (spare < line.quantity) continue;

        pool.set(key, spare - line.quantity);
        // The product-level figure has to fall too, or a later unsplit match
        // could promise the same metal twice.
        if (split) {
          const pKey = `${batch.id}:${product.id}`;
          productSpare.set(
            pKey,
            Math.max(0, (productSpare.get(pKey) ?? 0) - line.quantity)
          );
        }

        suggestions.push({
          lineItemId: line.lineItemId,
          orderName: line.orderName,
          quantity: line.quantity,
          productTitle: candidate.productTitle,
          variantTitle:
            candidate.variants.find((v) => v.variantId === line.variantId)
              ?.variantTitle ?? "",
          promisedDate: line.promisedDate,
          batchId: batch.id,
          batchName: batch.name,
          batchProductId: product.id,
          batchStage: batch.stage,
          spareAfter: pool.get(key) ?? 0,
        });
        break; // this line is spoken for
      }
    }
  }

  return suggestions;
}

/**
 * Apply the plan.
 *
 * The plan is recomputed here rather than taken from the client: the preview
 * the merchant saw may be minutes old, and the pieces it offered could have
 * been claimed since. Recomputing means the write can only ever do something
 * that is still true.
 */
export async function autoAllocate(params: {
  admin: AdminApiContext;
  shop: string;
  by?: string | null;
}): Promise<number> {
  const page = await getBatchPage(params.admin, params.shop);
  if (page.suggestions.length === 0) return 0;

  const [board, routes] = await Promise.all([
    getBoard(params.admin, params.shop),
    loadRoutes(params.shop),
  ]);
  const byLineItem = new Map(board.lines.map((l) => [l.lineItemId, l]));
  const byBatch = new Map(page.batches.map((b) => [b.id, b]));

  let applied = 0;
  for (const suggestion of page.suggestions) {
    const line = byLineItem.get(suggestion.lineItemId);
    const batch = byBatch.get(suggestion.batchId);
    if (!line || !batch) continue;

    await db.batchItem.createMany({
      data: [
        {
          batchProductId: suggestion.batchProductId,
          lineItemId: line.lineItemId,
          orderId: line.orderId,
          orderName: line.orderName,
          variantId: line.variantId,
          quantity: line.quantity,
        },
      ],
      skipDuplicates: true,
    });

    // The piece filling this order is already at the run's stage, so the
    // order line belongs there too.
    await moveLine({
      shop: params.shop,
      line,
      to: variantPosition(
        batch.stage,
        batch.status,
        routeFor(routes, line.variantId)
      ),
      by: params.by,
    });
    applied += 1;
  }

  console.log(`[batch] auto-allocated ${applied} order line(s) from surplus`);
  return applied;
}

/** Every remembered variant route for this shop. */
export async function loadRoutes(shop: string): Promise<RouteMap> {
  const rows = await db.variantRoute.findMany({
    where: { shop },
    select: { variantId: true, skipStages: true },
  });
  return new Map(rows.map((r) => [r.variantId, r.skipStages]));
}

/** A line that still needs manufacturing — i.e. is not already finished. */
export function needsMaking(line: { column: BoardColumn }): boolean {
  return line.column !== "READY_TO_SHIP";
}

function buildCandidates(
  lines: TrackedLine[],
  claimed: Set<string>
): BatchCandidate[] {
  const groups = new Map<string, BatchCandidate>();
  const variantTally = new Map<string, Map<string, CandidateVariant>>();

  for (const line of lines) {
    if (claimed.has(line.lineItemId)) continue;

    let group = groups.get(line.productId);
    if (!group) {
      group = {
        productId: line.productId,
        productTitle: line.productTitle,
        productType: line.productType,
        imageUrl: line.imageUrl,
        pieces: 0,
        readyPieces: 0,
        variants: [],
        lines: [],
        earliestPromised: null,
      };
      groups.set(line.productId, group);
      variantTally.set(line.productId, new Map());
    }

    // Already finished: the piece exists, so it is not work to be made.
    if (!needsMaking(line)) {
      group.readyPieces += line.quantity;
      continue;
    }

    group.pieces += line.quantity;
    group.lines.push({
      lineItemId: line.lineItemId,
      orderId: line.orderId,
      orderName: line.orderName,
      variantId: line.variantId,
      quantity: line.quantity,
      promisedDate: line.promisedDate,
      column: line.column,
    });

    // Demand per finish, so the builder can show what the split will need.
    const tally = variantTally.get(line.productId)!;
    const existing = tally.get(line.variantId);
    if (existing) existing.pieces += line.quantity;
    else
      tally.set(line.variantId, {
        variantId: line.variantId,
        variantTitle: line.variantTitle,
        sku: line.sku,
        pieces: line.quantity,
      });

    if (
      line.promisedDate &&
      (!group.earliestPromised || line.promisedDate < group.earliestPromised)
    ) {
      group.earliestPromised = line.promisedDate;
    }
  }

  for (const [productId, tally] of variantTally) {
    const group = groups.get(productId);
    if (group) {
      group.variants = [...tally.values()].sort((a, b) => b.pieces - a.pieces);
    }
  }

  return [...groups.values()]
    .filter((g) => g.pieces > 0)
    .sort((a, b) => b.pieces - a.pieces);
}

type BatchRow = Awaited<
  ReturnType<
    typeof db.batch.findMany<{
      include: {
        products: { include: { finishes: true; items: true; scraps: true } };
      };
    }>
  >
>[number];

function toBatchView(
  row: BatchRow,
  byLineItem: Map<string, TrackedLine>,
  candidates: Map<string, BatchCandidate>,
  routes: RouteMap
): BatchView {
  const status = isBatchStatus(row.status) ? row.status : "OPEN";
  const stage = (row.stage as TrackStage | null) ?? null;

  const outstanding: TrackedLine[] = [];
  let totalLines = 0;
  let closedLines = 0;
  let changedLines = 0;
  const needed = new Set<TrackStage>();

  const products: BatchProductView[] = row.products.map((product) => {
    const lines: BatchLineView[] = product.items.map((item) => {
      const live = byLineItem.get(item.lineItemId);
      if (live) outstanding.push(live);
      const changed = Boolean(live) && live!.quantity !== item.quantity;
      if (changed) changedLines += 1;
      return {
        lineItemId: item.lineItemId,
        orderId: item.orderId,
        orderName: item.orderName,
        variantId: item.variantId,
        variantTitle: live?.variantTitle ?? "",
        snapshotQuantity: item.quantity,
        liveQuantity: live?.quantity ?? null,
        changed,
        column: live?.column ?? null,
        promisedDate: live?.promisedDate ?? null,
      };
    });

    totalLines += lines.length;
    const closed = lines.filter((l) => l.liveQuantity === null).length;
    closedLines += closed;

    const scrapped = product.scraps.reduce((sum, s) => sum + s.quantity, 0);
    const made = madeQuantity(product.plannedQuantity, scrapped);
    const committed = lines.reduce((sum, l) => sum + (l.liveQuantity ?? 0), 0);

    // Live demand per finish — the floor the split handler must respect.
    const demand = new Map<string, number>();
    // Names straight from the orders, used to fill in any finish stored
    // without one. Belt and braces: the split now records a title when it
    // creates a finish, but rows written before it did shouldn't render as
    // a dash forever.
    const nameFromOrders = new Map<string, string>();
    for (const line of lines) {
      if (line.variantTitle) nameFromOrders.set(line.variantId, line.variantTitle);
      if (line.liveQuantity === null) continue;
      demand.set(
        line.variantId,
        (demand.get(line.variantId) ?? 0) + line.liveQuantity
      );
    }

    const splitStage = isStage(product.splitStage) ? product.splitStage : null;

    const finishes: FinishView[] = product.finishes.map((finish) => {
      const skip = routeFor(routes, finish.variantId);
      const remaining = STAGES.filter(
        (s) =>
          !skip.includes(s) &&
          splitStage !== null &&
          STAGES.indexOf(s) >= STAGES.indexOf(splitStage)
      );
      for (const s of STAGES) if (!skip.includes(s)) needed.add(s);

      return {
        id: finish.id,
        variantId: finish.variantId,
        variantTitle:
          finish.variantTitle || (nameFromOrders.get(finish.variantId) ?? ""),
        sku: finish.sku,
        quantity: finish.quantity,
        committed: demand.get(finish.variantId) ?? 0,
        remainingStages: remaining,
        doneAtSplit: remaining.length === 0,
        inventoryDelta: finish.inventoryDelta,
      };
    });

    const allocated = finishes.reduce((sum, f) => sum + f.quantity, 0);
    const reachedSplit =
      splitStage !== null &&
      (status === "MADE" ||
        (stage !== null && STAGES.indexOf(stage) >= STAGES.indexOf(splitStage)));

    return {
      id: product.id,
      productId: product.productId,
      productTitle: product.productTitle,
      imageUrl: product.imageUrl,
      plannedQuantity: product.plannedQuantity,
      scrapped,
      made,
      allocated,
      reconciled: allocated === made,
      committed,
      surplus: surplusOf(made, committed),
      shortfall: shortfallOf(product.plannedQuantity, scrapped, committed),
      splitStage,
      splitDecidedAt: product.splitDecidedAt?.toISOString() ?? null,
      // Only worth prompting for when there is more than one way to finish it.
      splitDue:
        reachedSplit && !product.splitDecidedAt && product.finishes.length > 1,
      finishes,
      lines,
      scraps: product.scraps
        .map((s) => ({
          id: s.id,
          quantity: s.quantity,
          stage: s.stage,
          variantId: s.variantId,
          note: s.note,
          createdAt: s.createdAt.toISOString(),
        }))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
      closedLines: closed,
      changedLines: lines.filter((l) => l.changed).length,
      unclaimedLines: candidates.get(product.productId)?.lines.length ?? 0,
      unclaimedPieces: candidates.get(product.productId)?.pieces ?? 0,
      earliestPromised: earliestOf(lines),
    };
  });

  const spread = stageSpread(outstanding);
  const expectedFor = (line: TrackedLine) =>
    variantPosition(stage, status, routeFor(routes, line.variantId));

  return {
    id: row.id,
    name: row.name,
    status,
    stage,
    note: row.note,
    products,
    plannedTotal: products.reduce((s, p) => s + p.plannedQuantity, 0),
    madeTotal: products.reduce((s, p) => s + p.made, 0),
    scrappedTotal: products.reduce((s, p) => s + p.scrapped, 0),
    committedTotal: products.reduce((s, p) => s + p.committed, 0),
    surplusTotal: products.reduce((s, p) => s + p.surplus, 0),
    shortfallTotal: products.reduce((s, p) => s + p.shortfall, 0),
    unreconciled: products.filter((p) => !p.reconciled).length,
    splitsDue: products.filter((p) => p.splitDue).length,
    neededStages: [...needed],
    earliestPromised: products.reduce<string | null>(
      (soonest, p) =>
        p.earliestPromised && (!soonest || p.earliestPromised < soonest)
          ? p.earliestPromised
          : soonest,
      null
    ),
    totalLines,
    closedLines,
    changedLines,
    allClosed: totalLines > 0 && closedLines === totalLines,
    spread: [...spread.entries()],
    // Each line is judged against ITS OWN route: a silver piece sitting at
    // Ready to ship while the run plates the gold is correct, not divergent.
    inStep: outstanding.every((l) => l.column === expectedFor(l)),
    inventorySyncedAt: row.inventorySyncedAt?.toISOString() ?? null,
    inventoryLocation: row.inventoryLocation,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function earliestOf(lines: BatchLineView[]): string | null {
  let soonest: string | null = null;
  for (const line of lines) {
    if (line.liveQuantity === null || !line.promisedDate) continue;
    if (!soonest || line.promisedDate < soonest) soonest = line.promisedDate;
  }
  return soonest;
}

// ── Creating a run ────────────────────────────────────────────────────────

export interface ProductSelection {
  productId: string;
  /** Raw pieces to make. */
  plannedQuantity: unknown;
}

/**
 * The next auto-name for this shop.
 *
 * Reads every run's name — including cancelled and archived ones — so a number
 * is never handed out twice. Only the name column is selected: the numbers are
 * all that matter here, and a run's products can be a large row to drag back
 * for a string.
 *
 * Two runs created in the same second could still both be offered the same
 * number. That is deliberately not guarded against with a lock or a unique
 * index: the name is a label, not a key, nothing joins on it, and the merchant
 * can see and change it in the field before saving. A one-workshop app does
 * not need a distributed counter to suggest a default.
 */
async function nextRunName(shop: string): Promise<string> {
  const rows = await db.batch.findMany({ where: { shop }, select: { name: true } });
  return runName(nextRunSequence(rows.map((r) => r.name)));
}

/**
 * Start a run covering any number of products.
 *
 * The client sends only product IDs and quantities; titles, images and order
 * lines are resolved server-side from the live board, so a tampered form
 * can't write a run for something nobody ordered.
 *
 * Finishes are seeded to cover committed demand exactly, with any surplus
 * placed on the largest-demand finish. That is a DEFAULT, not a decision —
 * it guarantees every order is coverable, and the real allocation happens in
 * the split handler once the pieces are polished.
 */
export async function createBatchFromSelection(params: {
  admin: AdminApiContext;
  shop: string;
  name: unknown;
  note?: unknown;
  products: ProductSelection[];
}): Promise<string> {
  if (params.products.length === 0) {
    throw new BatchError("Pick at least one product for this run.");
  }

  const prepared = await prepareProducts(params);

  // Numbered at write time, not when the builder opened: the page's suggestion
  // can be minutes stale if another run was started in the meantime. An empty
  // field means "number it for me", so the query only runs when it has to.
  const chosen = cleanBatchName(params.name, "");
  const named = chosen === "" ? await nextRunName(params.shop) : chosen;

  const batch = await db.batch.create({
    data: {
      shop: params.shop,
      name: named,
      note: cleanBatchNote(params.note),
      status: "OPEN",
      stage: null,
      products: { create: prepared },
    },
  });

  return batch.id;
}

/** Add more products to a run that is still open. */
export async function addProductsToBatch(params: {
  admin: AdminApiContext;
  shop: string;
  batchId: string;
  products: ProductSelection[];
  by?: string | null;
}): Promise<void> {
  const batch = await loadBatch(params.shop, params.batchId);
  if (batch.status !== "OPEN") {
    throw new BatchError("This run is finished — its contents can't change.");
  }
  if (params.products.length === 0) return;

  const prepared = await prepareProducts({
    ...params,
    skip: new Set(batch.products.map((p) => p.productId)),
  });

  const board = await getBoard(params.admin, params.shop);
  const routes = await loadRoutes(params.shop);
  const status = isBatchStatus(batch.status) ? batch.status : "OPEN";
  const stage = (batch.stage as TrackStage | null) ?? null;

  for (const product of prepared) {
    await db.batchProduct.create({
      data: { batchId: params.batchId, ...product },
    });

    // Join the run where the run already is, or the new pieces sit at
    // Untriaged while the tree they were added to is at Casting.
    const added = new Set(product.items.create.map((i) => i.lineItemId));
    for (const line of board.lines.filter((l) => added.has(l.lineItemId))) {
      await moveLine({
        shop: params.shop,
        line,
        to: variantPosition(stage, status, routeFor(routes, line.variantId)),
        by: params.by,
      });
    }
  }
}

async function prepareProducts(params: {
  admin: AdminApiContext;
  shop: string;
  products: ProductSelection[];
  skip?: Set<string>;
}) {
  const { admin, shop, skip } = params;
  const selections = params.products.filter((s) => !skip?.has(s.productId));
  if (selections.length === 0) return [];

  const board = await getBoard(admin, shop);
  const claimedIds = await claimedLineIds(shop);

  const linesFor = (productId: string) =>
    board.lines.filter(
      (l) =>
        l.productId === productId &&
        !claimedIds.has(l.lineItemId) &&
        needsMaking(l)
    );

  // Only products with nothing outstanding need a catalogue lookup, so a run
  // built purely from ordered work costs no extra Shopify call.
  const needLookup = selections
    .filter((s) => linesFor(s.productId).length === 0)
    .map((s) => s.productId);
  const catalogue =
    needLookup.length > 0 ? await fetchVariants(admin, needLookup) : new Map();

  return selections.map((selection) => {
    const lines = linesFor(selection.productId);
    const sample = lines[0];
    const known = [...catalogue.values()].find(
      (v) => v.productId === selection.productId
    );

    const identity = sample
      ? {
          productId: sample.productId,
          productTitle: sample.productTitle,
          imageUrl: sample.imageUrl,
        }
      : known
        ? {
            productId: known.productId,
            productTitle: known.productTitle,
            imageUrl: known.imageUrl,
          }
        : null;

    if (!identity) {
      throw new BatchError(
        "One of those products no longer exists in Shopify. Refresh and try again."
      );
    }

    const committed = lines.reduce((sum, l) => sum + l.quantity, 0);
    const raw = cleanPlannedQuantity(selection.plannedQuantity, committed);
    if (raw === null || raw === 0) {
      throw new BatchError(
        `Enter how many pieces of ${identity.productTitle} the run will make.`
      );
    }

    return {
      ...identity,
      plannedQuantity: raw,
      splitStage: "PLATING",
      items: {
        create: lines.map((l) => ({
          lineItemId: l.lineItemId,
          orderId: l.orderId,
          orderName: l.orderName,
          variantId: l.variantId,
          quantity: l.quantity,
        })),
      },
      finishes: { create: seedFinishes(lines, raw) },
    };
  });
}

/**
 * The starting allocation across finishes.
 *
 * Every finish with orders gets exactly what it owes; the leftover goes to
 * whichever finish is most in demand, or to the first variant when the run is
 * pure stock. Deliberately a covering default rather than a guess at the real
 * split — nobody has to decide that until the pieces are polished.
 */
function seedFinishes(lines: TrackedLine[], raw: number) {
  const demand = new Map<
    string,
    { variantId: string; variantTitle: string; sku: string | null; qty: number }
  >();

  for (const line of lines) {
    const existing = demand.get(line.variantId);
    if (existing) existing.qty += line.quantity;
    else
      demand.set(line.variantId, {
        variantId: line.variantId,
        variantTitle: line.variantTitle,
        sku: line.sku,
        qty: line.quantity,
      });
  }

  const finishes = [...demand.values()].sort((a, b) => b.qty - a.qty);
  if (finishes.length === 0) return [];

  const committed = finishes.reduce((sum, f) => sum + f.qty, 0);
  const surplus = Math.max(0, raw - committed);

  return finishes.map((f, i) => ({
    variantId: f.variantId,
    variantTitle: f.variantTitle,
    sku: f.sku,
    quantity: i === 0 ? f.qty + surplus : f.qty,
  }));
}

async function claimedLineIds(shop: string): Promise<Set<string>> {
  const rows = await db.batchItem.findMany({
    where: { batchProduct: { batch: { shop, status: { in: CLAIMING_STATUSES } } } },
    select: { lineItemId: true },
  });
  return new Set(rows.map((r) => r.lineItemId));
}

// ── The plating handler ───────────────────────────────────────────────────

/**
 * Allocate a product's surviving pieces across finishes.
 *
 * This is the decision the whole model exists to defer: the pieces are
 * polished, the week's orders are known, and only now does anyone say how
 * many get plated. Everything else about the run is unaffected — order lines
 * move by their own variant's route, not by this.
 *
 * One hard invariant: the allocation must total exactly what SURVIVED.
 * Writing stock that doesn't exist is the one error nobody could detect from
 * the app, so that is a refusal rather than a silent correction.
 *
 * The per-finish floor — "no finish gets less than it owes" — is enforced only
 * while there are enough pieces to go round. Once breakage eats past the
 * surplus the two rules contradict each other: with one piece left and two
 * orders, every allocation is simultaneously too small somewhere and correct
 * in total, and demanding both left the merchant with a dialog that could
 * never be submitted. When the pieces genuinely aren't there, somebody has to
 * choose which order waits — so the app takes the allocation and reports the
 * unfilled orders instead of pretending the choice can be avoided.
 */
export async function splitFinishes(params: {
  shop: string;
  batchId: string;
  batchProductId: string;
  /** variantId → pieces. */
  allocation: Record<string, unknown>;
  admin: AdminApiContext;
}): Promise<void> {
  const batch = await loadBatch(params.shop, params.batchId);
  if (batch.inventorySyncedAt) {
    throw new BatchError(
      "Stock has already been written for this run, so its counts are fixed."
    );
  }
  if (batch.status === "CANCELLED" || batch.status === "CLOSED") {
    throw new BatchError("This run is closed.");
  }

  const product = batch.products.find((p) => p.id === params.batchProductId);
  if (!product) throw new BatchError("That product isn't in this run.");

  const scrapped = product.scraps.reduce((sum, s) => sum + s.quantity, 0);
  const made = madeQuantity(product.plannedQuantity, scrapped);

  // Live demand per finish sets each floor.
  const board = await getBoard(params.admin, params.shop);
  const live = new Map(board.lines.map((l) => [l.lineItemId, l]));
  const demand = new Map<string, number>();
  for (const item of product.items) {
    const l = live.get(item.lineItemId);
    if (!l) continue;
    demand.set(item.variantId, (demand.get(item.variantId) ?? 0) + l.quantity);
  }

  const wanted = new Map<string, number>();
  let total = 0;
  for (const [variantId, raw] of Object.entries(params.allocation)) {
    const n = Math.floor(Number(String(raw ?? "").trim()));
    if (!Number.isFinite(n) || n < 0) {
      throw new BatchError("Every finish needs a whole number of pieces.");
    }
    wanted.set(variantId, n);
    total += n;
  }

  if (total !== made) {
    throw new BatchError(
      `${made} pieces will exist but ${total} were allocated. The split has to account for every piece.`
    );
  }

  // Only hold each finish to what it owes while the run can actually cover
  // every order. Short of that the floor is unsatisfiable by arithmetic, and
  // the merchant is choosing which order waits — see the doc comment.
  const owedTotal = [...demand.values()].reduce((sum, n) => sum + n, 0);
  if (made >= owedTotal) {
    for (const [variantId, owed] of demand) {
      const got = wanted.get(variantId) ?? 0;
      if (got < owed) {
        const title =
          product.finishes.find((f) => f.variantId === variantId)
            ?.variantTitle ?? "that finish";
        throw new BatchError(
          `${title} has ${owed} on order but only ${got} allocated.`
        );
      }
    }
  }

  // Names for finishes being created, and for any stored blank. An order line
  // carries its variant's title, but a finish plated purely for stock has no
  // order behind it — so anything still unnamed is looked up in the catalogue.
  const titleFromOrders = new Map<string, string>();
  for (const item of product.items) {
    const l = live.get(item.lineItemId);
    if (l?.variantTitle) titleFromOrders.set(item.variantId, l.variantTitle);
  }
  const unnamed = [...wanted.keys()].filter((variantId) => {
    if (titleFromOrders.has(variantId)) return false;
    const existing = product.finishes.find((f) => f.variantId === variantId);
    return !existing || !existing.variantTitle;
  });
  const catalogue =
    unnamed.length > 0
      ? await fetchVariants(params.admin, unnamed).catch(() => new Map())
      : new Map();

  const nameOf = (variantId: string) =>
    titleFromOrders.get(variantId) ??
    catalogue.get(variantId)?.variantTitle ??
    product.finishes.find((f) => f.variantId === variantId)?.variantTitle ??
    "";

  await db.$transaction(async (tx) => {
    for (const [variantId, quantity] of wanted) {
      const existing = product.finishes.find((f) => f.variantId === variantId);

      // A finish with no pieces is not a finish. Storing zeroes left blank
      // rows on the run, the sheet and the stock dialog.
      if (quantity === 0) {
        if (existing) await tx.batchFinish.delete({ where: { id: existing.id } });
        continue;
      }

      if (existing) {
        await tx.batchFinish.update({
          where: { id: existing.id },
          data: {
            quantity,
            // Repair a blank stored earlier without overwriting a good name.
            ...(existing.variantTitle ? {} : { variantTitle: nameOf(variantId) }),
          },
        });
      } else {
        await tx.batchFinish.create({
          data: {
            batchProductId: product.id,
            variantId,
            variantTitle: nameOf(variantId),
            sku: catalogue.get(variantId)?.sku ?? null,
            quantity,
          },
        });
      }
    }
    // Finishes left out of the allocation entirely.
    for (const finish of product.finishes) {
      if (!wanted.has(finish.variantId)) {
        await tx.batchFinish.delete({ where: { id: finish.id } });
      }
    }
    await tx.batchProduct.update({
      where: { id: product.id },
      data: { splitDecidedAt: new Date() },
    });
  });
}

/** Remember a variant's path so future runs don't have to be told again. */
export async function setVariantRoute(params: {
  shop: string;
  productId: string;
  variantId: string;
  skipStages: string[];
}): Promise<void> {
  const skip = params.skipStages.filter(isStage);
  await db.variantRoute.upsert({
    where: { shop_variantId: { shop: params.shop, variantId: params.variantId } },
    create: {
      shop: params.shop,
      productId: params.productId,
      variantId: params.variantId,
      skipStages: skip,
    },
    update: { skipStages: skip },
  });
}

// ── Editing a run ─────────────────────────────────────────────────────────

export async function updateBatch(params: {
  shop: string;
  batchId: string;
  name?: unknown;
  note?: unknown;
}): Promise<void> {
  const batch = await loadBatch(params.shop, params.batchId);
  if (batch.status === "CANCELLED") throw new BatchError("This run was cancelled.");

  const data: { name?: string; note?: string | null } = {};
  // Falls back to the name it already has: clearing the box is a slip, not a
  // request to be renumbered, and issuing a fresh number here would leave a
  // gap in the sequence for a run that never needed one.
  if (params.name !== undefined) data.name = cleanBatchName(params.name, batch.name);
  if (params.note !== undefined) data.note = cleanBatchNote(params.note);
  if (Object.keys(data).length === 0) return;

  await db.batch.update({ where: { id: params.batchId }, data });
}

/** Change how many raw pieces the run makes of one product. */
export async function updateBatchProduct(params: {
  admin: AdminApiContext;
  shop: string;
  batchId: string;
  batchProductId: string;
  plannedQuantity: unknown;
}): Promise<void> {
  const batch = await loadBatch(params.shop, params.batchId);
  if (batch.status !== "OPEN") {
    throw new BatchError(
      "This run is already finished — its quantities can't be changed."
    );
  }
  const product = batch.products.find((p) => p.id === params.batchProductId);
  if (!product) throw new BatchError("That product isn't in this run.");

  // Floored on the LIVE committed total: order editing can raise a line's
  // quantity in place, so the stored snapshots can be smaller than what is
  // owed, and flooring on them would accept a run that makes too few.
  const board = await getBoard(params.admin, params.shop);
  const owed = new Map(board.lines.map((l) => [l.lineItemId, l.quantity]));
  const committed = product.items.reduce(
    (sum, i) => sum + (owed.get(i.lineItemId) ?? 0),
    0
  );

  const raw = cleanPlannedQuantity(params.plannedQuantity, committed);
  if (raw === null) throw new BatchError("Enter a whole number of pieces.");

  await db.$transaction(async (tx) => {
    await tx.batchProduct.update({
      where: { id: product.id },
      data: { plannedQuantity: raw },
    });
    // Keep the allocation covering: put the change on the largest finish so
    // the product stays reconciled without anyone re-splitting.
    const scrapped = product.scraps.reduce((sum, s) => sum + s.quantity, 0);
    const target = madeQuantity(raw, scrapped);
    const finishes = [...product.finishes].sort((a, b) => b.quantity - a.quantity);
    const allocated = finishes.reduce((sum, f) => sum + f.quantity, 0);
    const delta = target - allocated;
    if (delta !== 0 && finishes[0]) {
      await tx.batchFinish.update({
        where: { id: finishes[0].id },
        data: { quantity: Math.max(0, finishes[0].quantity + delta) },
      });
    }
  });
}

export async function removeProductFromBatch(params: {
  admin: AdminApiContext;
  shop: string;
  batchId: string;
  batchProductId: string;
}): Promise<void> {
  const batch = await loadBatch(params.shop, params.batchId);
  if (batch.status !== "OPEN") {
    throw new BatchError("This run is finished — its contents can't change.");
  }
  const product = batch.products.find((p) => p.id === params.batchProductId);
  if (!product) return;

  const memberIds = new Set(product.items.map((i) => i.lineItemId));
  const board = await getBoard(params.admin, params.shop);

  await db.batchProduct.deleteMany({
    where: { id: params.batchProductId, batchId: params.batchId },
  });

  await releaseLines({
    shop: params.shop,
    lines: board.lines.filter((l) => memberIds.has(l.lineItemId)),
  });
}

export async function addUnclaimedLines(params: {
  admin: AdminApiContext;
  shop: string;
  batchId: string;
  batchProductId: string;
  by?: string | null;
}): Promise<void> {
  const batch = await loadBatch(params.shop, params.batchId);
  if (batch.status !== "OPEN") {
    throw new BatchError(
      "This run is finished. New orders will be filled from the stock it produced."
    );
  }
  const product = batch.products.find((p) => p.id === params.batchProductId);
  if (!product) throw new BatchError("That product isn't in this run.");

  const board = await getBoard(params.admin, params.shop);
  const claimedIds = await claimedLineIds(params.shop);
  const routes = await loadRoutes(params.shop);

  const fresh = board.lines.filter(
    (l) =>
      l.productId === product.productId &&
      !claimedIds.has(l.lineItemId) &&
      needsMaking(l)
  );
  if (fresh.length === 0) {
    throw new BatchError("There are no new orders to make for that product.");
  }

  // Don't take on more than the run can actually deliver. This used to accept
  // every new order regardless of spare capacity, which quietly turned a run
  // with two pieces going spare and five new orders into a three-piece
  // shortfall — the same dead end breakage causes.
  const scrapped = product.scraps.reduce((sum, s) => sum + s.quantity, 0);
  const made = madeQuantity(product.plannedQuantity, scrapped);
  const committed = product.items.reduce(
    (sum, i) => sum + (board.lines.find((l) => l.lineItemId === i.lineItemId)?.quantity ?? 0),
    0
  );
  let spare = Math.max(0, made - committed);

  const affordable: TrackedLine[] = [];
  for (const line of fresh) {
    if (line.quantity > spare) continue; // taken whole or not at all
    spare -= line.quantity;
    affordable.push(line);
  }
  if (affordable.length === 0) {
    throw new BatchError(
      `This run has no spare pieces of ${product.productTitle}. Start another run.`
    );
  }

  await db.batchItem.createMany({
    data: affordable.map((l) => ({
      batchProductId: product.id,
      lineItemId: l.lineItemId,
      orderId: l.orderId,
      orderName: l.orderName,
      variantId: l.variantId,
      quantity: l.quantity,
    })),
    skipDuplicates: true,
  });

  const status = isBatchStatus(batch.status) ? batch.status : "OPEN";
  const stage = (batch.stage as TrackStage | null) ?? null;
  for (const line of affordable) {
    await moveLine({
      shop: params.shop,
      line,
      to: variantPosition(stage, status, routeFor(routes, line.variantId)),
      by: params.by,
    });
  }
}

export async function removeLineFromBatch(params: {
  admin: AdminApiContext;
  shop: string;
  batchId: string;
  lineItemId: string;
}): Promise<void> {
  const batch = await loadBatch(params.shop, params.batchId);
  if (batch.status !== "OPEN") {
    throw new BatchError("This run is finished — its orders can't be changed.");
  }
  await db.batchItem.deleteMany({
    where: {
      lineItemId: params.lineItemId,
      batchProduct: { batchId: params.batchId },
    },
  });

  const board = await getBoard(params.admin, params.shop);
  await releaseLines({
    shop: params.shop,
    lines: board.lines.filter((l) => l.lineItemId === params.lineItemId),
  });
}

// ── Scrap ─────────────────────────────────────────────────────────────────

export async function recordScrap(params: {
  shop: string;
  batchId: string;
  batchProductId: string;
  quantity: unknown;
  note?: unknown;
}): Promise<void> {
  const batch = await loadBatch(params.shop, params.batchId);
  if (batch.inventorySyncedAt) {
    throw new BatchError(
      "Stock has already been written for this run, so its counts are fixed. Adjust the stock in Shopify instead."
    );
  }
  if (batch.status === "CANCELLED" || batch.status === "CLOSED") {
    throw new BatchError("This run is closed.");
  }

  const product = batch.products.find((p) => p.id === params.batchProductId);
  if (!product) throw new BatchError("That product isn't in this run.");

  const n = Math.floor(Number(String(params.quantity ?? "").trim()));
  if (!Number.isFinite(n) || n <= 0) {
    throw new BatchError("Enter how many pieces were lost.");
  }

  const already = product.scraps.reduce((sum, s) => sum + s.quantity, 0);
  if (already + n > product.plannedQuantity) {
    throw new BatchError(
      `This run only makes ${product.plannedQuantity} of that piece and ${already} are already recorded as lost.`
    );
  }

  await db.batchScrap.create({
    data: {
      batchProductId: product.id,
      quantity: n,
      // A raw piece has no finish yet; only losses after the split name one.
      variantId: null,
      stage: (batch.stage as string | null) ?? null,
      note: cleanScrapNote(params.note),
    },
  });
}

export async function removeScrap(params: {
  shop: string;
  batchId: string;
  scrapId: string;
}): Promise<void> {
  const batch = await loadBatch(params.shop, params.batchId);
  if (batch.inventorySyncedAt) {
    throw new BatchError(
      "Stock has already been written for this run, so its counts are fixed."
    );
  }
  await db.batchScrap.deleteMany({
    where: { id: params.scrapId, batchProduct: { batchId: params.batchId } },
  });
}

function cleanScrapNote(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().slice(0, SCRAP_NOTE_MAX);
  return trimmed === "" ? null : trimmed;
}

// ── Moving a run through the workshop ─────────────────────────────────────

export async function advanceBatch(params: {
  admin: AdminApiContext;
  shop: string;
  batchId: string;
  by?: string | null;
}): Promise<void> {
  const { batch, memberLines, routes } = await loadBatchContext(params);
  if (batch.status !== "OPEN") throw new BatchError("This run has already finished.");

  const stage = (batch.stage as TrackStage | null) ?? null;
  const step = nextBatchStep(stage, neededFor(batch, routes));

  await moveByRoute({
    shop: params.shop,
    lines: memberLines,
    routes,
    from: { stage, status: "OPEN" },
    to: { stage: step.stage, status: step.status },
    by: params.by,
  });

  await db.batch.update({
    where: { id: batch.id },
    data: { stage: step.stage, status: step.status },
  });
}

export async function revertBatch(params: {
  admin: AdminApiContext;
  shop: string;
  batchId: string;
  by?: string | null;
}): Promise<void> {
  const { batch, memberLines, routes } = await loadBatchContext(params);
  const status = isBatchStatus(batch.status) ? batch.status : "OPEN";

  if (status === "CLOSED" || status === "CANCELLED") {
    throw new BatchError("This run is archived.");
  }
  if (batch.inventorySyncedAt) {
    throw new BatchError(
      "Stock has already been written to Shopify for this run, so it can't be re-opened. Adjust the stock in Shopify instead."
    );
  }

  const stage = (batch.stage as TrackStage | null) ?? null;
  const back = prevBatchStep(stage, status, neededFor(batch, routes));
  if (!back) throw new BatchError("This run hasn't started yet.");

  await moveByRoute({
    shop: params.shop,
    lines: memberLines,
    routes,
    from: { stage, status },
    to: back,
    by: params.by,
  });

  await db.batch.update({
    where: { id: batch.id },
    data: { stage: back.stage, status: back.status },
  });
}

export async function pullBatchToStage(params: {
  admin: AdminApiContext;
  shop: string;
  batchId: string;
  by?: string | null;
}): Promise<void> {
  const { batch, memberLines, routes } = await loadBatchContext(params);
  const status = isBatchStatus(batch.status) ? batch.status : "OPEN";
  const stage = (batch.stage as TrackStage | null) ?? null;

  for (const line of memberLines) {
    await moveLine({
      shop: params.shop,
      line,
      to: variantPosition(stage, status, routeFor(routes, line.variantId)),
      by: params.by,
    });
  }
}

/** The union of stages anything in this run still needs. */
function neededFor(
  batch: { products: Array<{ finishes: Array<{ variantId: string }>; items: Array<{ variantId: string }> }> },
  routes: RouteMap
): Set<TrackStage> {
  const needed = new Set<TrackStage>();
  for (const product of batch.products) {
    const ids = [
      ...product.finishes.map((f) => f.variantId),
      ...product.items.map((i) => i.variantId),
    ];
    for (const variantId of ids) {
      const skip = routeFor(routes, variantId);
      for (const s of STAGES) if (!skip.includes(s)) needed.add(s);
    }
  }
  return needed;
}

/**
 * Move each line from where its variant WAS to where its variant now IS.
 *
 * Positions come from the line's own route, which is the whole skipped-stage
 * behaviour: when the run steps Polishing → Plating, a silver line has no
 * further stages so it lands on Ready to ship, while the gold beside it goes
 * to Plating. Only lines actually sitting at `from` are touched, so a piece
 * somebody sent back by hand is left where it is.
 */
async function moveByRoute(params: {
  shop: string;
  lines: TrackedLine[];
  routes: RouteMap;
  from: { stage: TrackStage | null; status: BatchStatus };
  to: { stage: TrackStage | null; status: BatchStatus };
  by?: string | null;
}): Promise<void> {
  for (const line of params.lines) {
    const skip = routeFor(params.routes, line.variantId);
    const from = variantPosition(params.from.stage, params.from.status, skip);
    const to = variantPosition(params.to.stage, params.to.status, skip);
    if (from === to || line.column !== from) continue;
    await moveLine({ shop: params.shop, line, to, by: params.by });
  }
}

function targetFor(column: BoardColumn): {
  status: "IN_MANUFACTURE" | "READY_TO_SHIP" | null;
  stage: TrackStage | null;
} {
  if (column === "READY_TO_SHIP") return { status: "READY_TO_SHIP", stage: null };
  if (column === UNTRIAGED) return { status: null, stage: null };
  return { status: "IN_MANUFACTURE", stage: column };
}

async function moveLine(params: {
  shop: string;
  line: TrackedLine;
  to: BoardColumn;
  by?: string | null;
}): Promise<void> {
  await setStatus({
    shop: params.shop,
    line: params.line as OrderLine,
    ...targetFor(params.to),
    by: params.by ?? null,
  });
}

/**
 * Send lines back to Untriaged when their run stops carrying them.
 *
 * Leaving them at the stage the run reached would strand them: nothing is
 * manufacturing them any more, while the batches page offers the same lines
 * as unclaimed work. Ready-to-ship lines are left alone — those pieces exist,
 * and abandoning a run doesn't un-make them.
 */
async function releaseLines(params: {
  shop: string;
  lines: TrackedLine[];
  by?: string | null;
}): Promise<void> {
  for (const line of params.lines) {
    if (line.column === "READY_TO_SHIP" || line.column === UNTRIAGED) continue;
    await moveLine({ shop: params.shop, line, to: UNTRIAGED, by: params.by });
  }
}

// ── Lifecycle ─────────────────────────────────────────────────────────────

export async function archiveBatch(shop: string, batchId: string): Promise<void> {
  const batch = await loadBatch(shop, batchId);
  if (batch.status === "CANCELLED") throw new BatchError("This run was cancelled.");
  await db.batch.update({ where: { id: batchId }, data: { status: "CLOSED" } });
}

export async function cancelBatch(params: {
  admin: AdminApiContext;
  shop: string;
  batchId: string;
  by?: string | null;
}): Promise<void> {
  const { batch, memberLines } = await loadBatchContext(params);
  if (batch.status !== "OPEN") {
    throw new BatchError("This run is already made — archive it instead of cancelling.");
  }
  await db.batch.update({
    where: { id: params.batchId },
    data: { status: "CANCELLED" },
  });
  await releaseLines({ shop: params.shop, lines: memberLines, by: params.by });
}

// ── Loading helpers ───────────────────────────────────────────────────────

export async function loadBatch(shop: string, batchId: string) {
  const batch = await db.batch.findFirst({
    where: { id: batchId, shop },
    include: {
      products: { include: { finishes: true, items: true, scraps: true } },
    },
  });
  if (!batch) throw new BatchError("That run no longer exists.");
  return batch;
}

async function loadBatchContext(params: {
  admin: AdminApiContext;
  shop: string;
  batchId: string;
}) {
  const [batch, board, routes] = await Promise.all([
    loadBatch(params.shop, params.batchId),
    getBoard(params.admin, params.shop),
    loadRoutes(params.shop),
  ]);

  const memberIds = new Set(
    batch.products.flatMap((p) => p.items.map((i) => i.lineItemId))
  );
  return {
    batch,
    routes,
    memberLines: board.lines.filter((l) => memberIds.has(l.lineItemId)),
  };
}
