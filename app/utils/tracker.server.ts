/**
 * Production tracker data layer.
 *
 * The governing idea: **Shopify owns what is outstanding, Postgres owns where
 * it is in production.** Every board read starts from live unfulfilled order
 * lines and left-joins the stored status onto them. Consequences worth knowing:
 *
 *   • A shipped line vanishes from the board by itself — no cleanup job, no
 *     stale rows, no "archived" flag to maintain.
 *   • An untriaged line needs no database row at all; absence *is* the
 *     Untriaged state. Rows appear the first time someone sets a status.
 *   • A tracked row whose line is no longer outstanding is simply not shown.
 *     It stays in the table as history rather than being deleted.
 */

import type { Prisma } from "@prisma/client";

import db from "../db.server";
import { fetchOrderLines, type OrderLine } from "./picklist.server";
import { LIVE_BATCH_STATUSES } from "./batching";
import {
  cleanNote,
  cleanPromisedDate,
  columnFor,
  isStage,
  isStatus,
  UNTRIAGED,
  type BoardColumn,
  type TrackStage,
  type TrackStatus,
} from "./tracking";
import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";

/** An outstanding order line plus whatever the workshop recorded about it. */
export interface TrackedLine extends OrderLine {
  status: TrackStatus | null; // null = untriaged
  stage: TrackStage | null;
  note: string | null;
  /** Calendar day promised to the customer, "YYYY-MM-DD". */
  promisedDate: string | null;
  column: BoardColumn;
  /** When the status last changed — drives the "sitting here N days" hint. */
  updatedAt: string | null;
  /**
   * The production run carrying this piece, if any.
   *
   * A stage on the board is often not an individual decision — it is where the
   * whole run got to. Without this the board can't say why a card moved, and
   * moving one card by hand looks identical to moving the run it belongs to.
   */
  batchId: string | null;
  batchName: string | null;
}

export interface BoardData {
  lines: TrackedLine[];
  counts: Record<BoardColumn, number>;
  /** When the underlying Shopify line list was last read. */
  fetchedAt: string;
  /** True if that list came from cache rather than a fresh sweep. */
  cached: boolean;
}

/**
 * The outstanding order lines, from cache when it is fresh enough.
 *
 * Reading them from Shopify means the full two-phase sweep — ~35 seconds for
 * ~740 open orders — which is far too slow to pay every time someone opens
 * the board. It is also wasted work: the set of outstanding lines changes a
 * few times a day, not a few times a minute.
 *
 * On a fetch failure with a cache present we deliberately serve the stale
 * copy rather than an error. A board that is a few minutes behind is useful;
 * an empty one is not, and the workshop's own statuses are unaffected either
 * way since those are never cached.
 */
export async function getOrderLines(
  admin: AdminApiContext,
  shop: string,
  opts: { force?: boolean } = {}
): Promise<{ lines: OrderLine[]; fetchedAt: string; cached: boolean }> {
  const row = await db.orderLineCache.findUnique({ where: { shop } });
  const age = row ? Date.now() - row.fetchedAt.getTime() : Infinity;

  if (row && !opts.force && age < CACHE_TTL_MS) {
    console.log(
      `[tracker] cache hit · ${row.lineCount} lines · ${Math.round(age / 1000)}s old`
    );
    return {
      lines: row.payload as unknown as OrderLine[],
      fetchedAt: row.fetchedAt.toISOString(),
      cached: true,
    };
  }

  try {
    const lines = await sweepOnce(admin, shop);
    const fetchedAt = new Date();

    await db.orderLineCache.upsert({
      where: { shop },
      create: {
        shop,
        fetchedAt,
        lineCount: lines.length,
        payload: lines as unknown as Prisma.InputJsonValue,
      },
      update: {
        fetchedAt,
        lineCount: lines.length,
        payload: lines as unknown as Prisma.InputJsonValue,
      },
    });

    return { lines, fetchedAt: fetchedAt.toISOString(), cached: false };
  } catch (error) {
    if (row) {
      console.error(
        "[tracker] refresh failed — serving stale cache instead:",
        error
      );
      return {
        lines: row.payload as unknown as OrderLine[],
        fetchedAt: row.fetchedAt.toISOString(),
        cached: true,
      };
    }
    throw error; // nothing cached — the caller shows a real error
  }
}

/**
 * How long a cached line list is served before a load refreshes it.
 *
 * The trade is narrow: the cache decides only WHICH lines are listed, so
 * being stale means "an order placed in the last few minutes isn't shown
 * yet". Fifteen minutes keeps the board effectively instant all day while
 * bounding that gap, and Refresh always forces a real read.
 */
const CACHE_TTL_MS = 15 * 60 * 1000;

/**
 * Sweeps currently running, keyed by shop.
 *
 * Without this, two people opening the board on a cold cache each start their
 * own 35-second sweep. That is not merely wasteful: both put batches in
 * flight at once, blowing past Shopify's cost budget and throttling each
 * other — the logs showed a pair of overlapping loads taking 57s instead of
 * 35s. Callers that arrive mid-sweep now await the existing one.
 *
 * Process-local, which is sufficient here: Render runs a single instance.
 */
const inFlight = new Map<string, Promise<OrderLine[]>>();

function sweepOnce(admin: AdminApiContext, shop: string): Promise<OrderLine[]> {
  const existing = inFlight.get(shop);
  if (existing) {
    console.log("[tracker] joining the sweep already in progress");
    return existing;
  }

  const run = fetchOrderLines(admin).finally(() => inFlight.delete(shop));
  inFlight.set(shop, run);
  return run;
}

/**
 * Everything the Track page renders: order lines joined with stored status,
 * plus per-column totals.
 *
 * `force` skips the cache — wired to the board's Refresh button.
 */
export async function getBoard(
  admin: AdminApiContext,
  shop: string,
  opts: { force?: boolean } = {}
): Promise<BoardData> {
  const { lines, fetchedAt, cached } = await getOrderLines(admin, shop, opts);

  const lineItemIds = lines.map((l) => l.lineItemId);

  // Two queries for the whole board rather than any per line.
  const [tracked, batched] = await Promise.all([
    db.trackedItem.findMany({ where: { shop, lineItemId: { in: lineItemIds } } }),
    // Which live run, if any, is carrying each piece.
    db.batchItem.findMany({
      where: {
        lineItemId: { in: lineItemIds },
        batchProduct: {
          batch: { shop, status: { in: [...LIVE_BATCH_STATUSES] } },
        },
      },
      select: {
        lineItemId: true,
        batchProduct: { select: { batch: { select: { id: true, name: true } } } },
      },
    }),
  ]);

  const byLineItem = new Map(tracked.map((t) => [t.lineItemId, t]));
  const runFor = new Map(
    batched.map((b) => [b.lineItemId, b.batchProduct.batch])
  );

  const counts = emptyCounts();

  const joined: TrackedLine[] = lines.map((line) => {
    const row = byLineItem.get(line.lineItemId);

    // Guard the stored strings: the column is free-form text, so a stage that
    // was renamed or removed in tracking.ts must not crash the board. An
    // unrecognised value degrades to untriaged rather than throwing.
    const status = isStatus(row?.status) ? row.status : null;
    const stage = isStage(row?.stage) ? row.stage : null;

    const column = columnFor(status, stage);
    counts[column] += 1;

    const run = runFor.get(line.lineItemId);

    return {
      ...line,
      status,
      stage,
      note: row?.note ?? null,
      promisedDate: row?.promisedDate ?? null,
      column,
      updatedAt: row?.updatedAt.toISOString() ?? null,
      batchId: run?.id ?? null,
      batchName: run?.name ?? null,
    };
  });

  return { lines: joined, counts, fetchedAt, cached };
}

/**
 * Record a status change, creating the tracking row on first touch.
 *
 * The order-line snapshot is passed in rather than re-fetched: the caller
 * already has it from the board, and storing it means the row still reads
 * correctly if the product is later renamed or deleted in Shopify.
 */
export async function setStatus(params: {
  shop: string;
  line: OrderLine;
  /** null returns the item to untriaged, keeping its row and history. */
  status: TrackStatus | null;
  stage: TrackStage | null;
  note?: string | null;
  by?: string | null;
}): Promise<void> {
  const { shop, line, status, by } = params;

  // A stage is meaningful only while manufacturing; clear it otherwise so the
  // two columns can never disagree about which board column the item is in.
  const stage = status === "IN_MANUFACTURE" ? params.stage : null;

  const existing = await db.trackedItem.findUnique({
    where: { shop_lineItemId: { shop, lineItemId: line.lineItemId } },
    select: { id: true, status: true, stage: true },
  });

  // No-op guard: repeated taps on the same stage shouldn't fill the history
  // with identical entries.
  if (existing && existing.status === status && existing.stage === stage) {
    if (params.note !== undefined) {
      await db.trackedItem.update({
        where: { id: existing.id },
        data: { note: params.note },
      });
    }
    return;
  }

  const snapshot = {
    orderId: line.orderId,
    orderName: line.orderName,
    productTitle: line.productTitle,
    variantTitle: line.variantTitle,
    sku: line.sku,
    quantity: line.quantity,
    imageUrl: line.imageUrl,
  };

  await db.$transaction(async (tx) => {
    const item = await tx.trackedItem.upsert({
      where: { shop_lineItemId: { shop, lineItemId: line.lineItemId } },
      create: {
        shop,
        lineItemId: line.lineItemId,
        ...snapshot,
        status,
        stage,
        note: params.note ?? null,
      },
      update: {
        ...snapshot, // refresh the snapshot; quantity can change via order edits
        status,
        stage,
        ...(params.note !== undefined ? { note: params.note } : {}),
      },
    });

    await tx.trackedItemEvent.create({
      data: {
        itemId: item.id,
        fromStatus: existing?.status ?? null,
        fromStage: existing?.stage ?? null,
        toStatus: status,
        toStage: stage,
        by: by ?? null,
      },
    });
  });
}

/**
 * Stage/status for a set of line items, for stamping onto a pick list.
 *
 * Returns a plain map rather than rows so the caller can annotate without
 * caring about the storage shape. Lines with no row simply aren't present —
 * the caller treats a miss as untriaged.
 */
export async function getStageMap(
  shop: string,
  lineItemIds: string[]
): Promise<Map<string, { status: string | null; stage: string | null }>> {
  if (lineItemIds.length === 0) return new Map();

  const rows = await db.trackedItem.findMany({
    where: { shop, lineItemId: { in: lineItemIds } },
    select: { lineItemId: true, status: true, stage: true },
  });

  return new Map(
    rows.map((r) => [r.lineItemId, { status: r.status, stage: r.stage }])
  );
}

/**
 * Set or clear the promised date and/or the free-text note.
 *
 * Either field may be omitted to leave it untouched. Creates the row if
 * needed with NO status, so both can be recorded at intake before anyone
 * decides make-vs-ship. Deliberately writes no movement event — the event log
 * tracks production stages, not admin edits.
 */
export async function setPromisedDate(params: {
  shop: string;
  line: OrderLine;
  promisedDate?: string | null;
  note?: string | null;
}): Promise<void> {
  const { shop, line } = params;

  const fields: { promisedDate?: string | null; note?: string | null } = {};
  if (params.promisedDate !== undefined) {
    fields.promisedDate = cleanPromisedDate(params.promisedDate);
  }
  if (params.note !== undefined) {
    fields.note = cleanNote(params.note);
  }
  if (Object.keys(fields).length === 0) return; // nothing asked for

  await db.trackedItem.upsert({
    where: { shop_lineItemId: { shop, lineItemId: line.lineItemId } },
    create: {
      shop,
      lineItemId: line.lineItemId,
      orderId: line.orderId,
      orderName: line.orderName,
      productTitle: line.productTitle,
      variantTitle: line.variantTitle,
      sku: line.sku,
      quantity: line.quantity,
      imageUrl: line.imageUrl,
      status: null, // still untriaged
      stage: null,
      promisedDate: fields.promisedDate ?? null,
      note: fields.note ?? null,
    },
    // Only the fields actually supplied, so setting a note never wipes a date.
    update: fields,
  });
}

/** Movement history for one line, newest first. */
export async function getHistory(shop: string, lineItemId: string) {
  const item = await db.trackedItem.findUnique({
    where: { shop_lineItemId: { shop, lineItemId } },
    include: { events: { orderBy: { at: "desc" } } },
  });
  return item?.events ?? [];
}

function emptyCounts(): Record<BoardColumn, number> {
  return {
    [UNTRIAGED]: 0,
    DESIGN: 0,
    CASTING: 0,
    WORKSHOP: 0,
    SETTING: 0,
    POLISHING: 0,
    PLATING: 0,
    READY_TO_SHIP: 0,
  };
}
