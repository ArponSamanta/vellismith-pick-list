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

import db from "../db.server";
import { fetchOrderLines, type OrderLine } from "./picklist.server";
import {
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
}

export interface BoardData {
  lines: TrackedLine[];
  counts: Record<BoardColumn, number>;
}

/**
 * Everything the Track page renders: live order lines joined with stored
 * status, plus per-column totals.
 */
export async function getBoard(
  admin: AdminApiContext,
  shop: string
): Promise<BoardData> {
  const lines = await fetchOrderLines(admin);

  // One query for the whole board rather than per line.
  const tracked = await db.trackedItem.findMany({
    where: { shop, lineItemId: { in: lines.map((l) => l.lineItemId) } },
  });
  const byLineItem = new Map(tracked.map((t) => [t.lineItemId, t]));

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

    return {
      ...line,
      status,
      stage,
      note: row?.note ?? null,
      promisedDate: row?.promisedDate ?? null,
      column,
      updatedAt: row?.updatedAt.toISOString() ?? null,
    };
  });

  return { lines: joined, counts };
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
 * Set or clear the free-text date the customer asked for.
 *
 * Creates the row if needed with NO status, so a promised date can be
 * recorded at intake before anyone decides make-vs-ship. Deliberately writes
 * no movement event — the event log tracks production stages, not admin edits.
 */
export async function setPromisedDate(params: {
  shop: string;
  line: OrderLine;
  promisedDate: string | null;
}): Promise<void> {
  const { shop, line } = params;
  const promisedDate = cleanPromisedDate(params.promisedDate);

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
      promisedDate,
    },
    update: { promisedDate },
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
