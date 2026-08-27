/**
 * Production tracker board.
 *
 * Every outstanding order line, grouped by where it sits in the workshop:
 * Untriaged → Design → Casting → Workshop → Setting → Polishing → Plating →
 * Ready to ship.
 *
 * Layout follows the pick list's lesson about small screens: a horizontally
 * scrolling column board on desktop, and a single grouped list with filter
 * chips on phones. No drag-and-drop — tapping a card opens the same editor on
 * both, which keeps one code path working identically on touch and mouse.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useFetcher } from "react-router";

import { authenticate } from "../shopify.server";
import type { OrderLine } from "../utils/picklist.server";
import type { loader as boardLoader } from "./app.track.board";
import {
  setPromisedDate,
  setStatus,
  type TrackedLine,
} from "../utils/tracker.server";

import {
  BOARD_COLUMNS,
  COLUMN_LABELS,
  STAGES,
  STAGE_LABELS,
  UNTRIAGED,
  NOTE_MAX,
  columnFor,
  formatPromisedDate,
  withinDateRange,
  isStage,
  isStatus,
  nextStep,
  prevStep,
  type BoardColumn,
  type TrackStage,
  type TrackStatus,
} from "../utils/tracking";

/** Where the board's data lives. Must match app.track.board's route path. */
const BOARD_ROUTE = "/app/track/board";

// ─── Server ───────────────────────────────────────────────────────────────

/**
 * Deliberately trivial: just the auth check.
 *
 * Anything expensive here delays the whole navigation, because React Router
 * keeps the previous route on screen until this resolves. The board's data
 * comes from app.track.board instead, fetched once this page is rendered.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return null;
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();

  const intent = String(form.get("intent") ?? "status");
  const lineItemId = String(form.get("lineItemId") ?? "");
  const rawStatus = String(form.get("status") ?? "");
  const rawStage = String(form.get("stage") ?? "");

  // "" is meaningful, not missing: an empty status means untriaged (the revert
  // target), and an empty stage means the status carries no stage.
  const status = rawStatus === "" ? null : rawStatus;
  const stage = rawStage === "" ? null : rawStage;

  if (!lineItemId) {
    return { ok: false, error: "Invalid status change." };
  }
  if (status !== null && !isStatus(status)) {
    return { ok: false, error: "Unknown status." };
  }
  if (stage !== null && !isStage(stage)) {
    return { ok: false, error: "Unknown stage." };
  }

  // The product snapshot rides along with the request rather than being
  // re-fetched from Shopify. Re-fetching would mean a full two-phase order
  // sweep (seconds) on every single tap — unusable for walking a piece
  // through six stages.
  //
  // It's safe because the snapshot is never what anyone sees: getBoard
  // spreads the live Shopify line FIRST and overrides only status/stage/note,
  // so titles, quantities and images on screen always come from Shopify. The
  // stored copy exists purely so historical rows still read correctly after a
  // product is renamed or deleted. And `shop` comes from the session, never
  // the form, so a forged line ID can only ever create a stray row inside the
  // caller's own shop — which nothing will display.
  const line: OrderLine = {
    lineItemId,
    orderId: String(form.get("orderId") ?? ""),
    orderName: String(form.get("orderName") ?? ""),
    orderCreatedAt: String(form.get("orderCreatedAt") ?? ""),
    productId: String(form.get("productId") ?? ""),
    productTitle: String(form.get("productTitle") ?? ""),
    productType: String(form.get("productType") ?? ""),
    variantId: String(form.get("variantId") ?? ""),
    variantTitle: String(form.get("variantTitle") ?? ""),
    sku: (form.get("sku") as string) || null,
    quantity: Number(form.get("quantity") ?? 0) || 0,
    imageUrl: (form.get("imageUrl") as string) || null,
  };

  try {
    if (intent === "details") {
      // Only the fields actually present are touched, so saving a note can't
      // clear the date and vice versa.
      const rawDate = form.get("promisedDate");
      const rawNote = form.get("note");
      await setPromisedDate({
        shop: session.shop,
        line,
        ...(rawDate !== null ? { promisedDate: String(rawDate) } : {}),
        ...(rawNote !== null ? { note: String(rawNote) } : {}),
      });
      return { ok: true, error: null };
    }

    await setStatus({
      shop: session.shop,
      line,
      status,
      stage,
      // Offline session tokens carry no user identity, so this is usually
      // null — the event timestamp is the reliable part. It populates only
      // if the app is ever switched to online tokens.
      by: session.onlineAccessInfo?.associated_user?.email ?? null,
    });
    return { ok: true, error: null };
  } catch (error) {
    console.error("[track] action error:", error);
    return { ok: false, error: "Couldn't save the change." };
  }
};

// ─── Icons ────────────────────────────────────────────────────────────────

const iconAttrs = (size: number, sw = 2) => ({
  width: size,
  height: size,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: sw,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
});

interface IconProps {
  size?: number;
}

const IconArrow = ({ size = 14, back = false }: IconProps & { back?: boolean }) => (
  <svg {...iconAttrs(size)}>
    <path d="M5 12h14" />
    <path d={back ? "m12 19-7-7 7-7" : "m12 5 7 7-7 7"} />
  </svg>
);
const IconX = ({ size = 16 }: IconProps) => (
  <svg {...iconAttrs(size)}>
    <path d="M18 6 6 18" />
    <path d="m6 6 12 12" />
  </svg>
);
const IconRefresh = ({ size = 15 }: IconProps) => (
  <svg {...iconAttrs(size)}>
    <path d="M3 12a9 9 0 0 1 9-9 9 9 0 0 1 6.7 3H21" />
    <path d="M21 3v6h-6" />
    <path d="M21 12a9 9 0 0 1-9 9 9 9 0 0 1-6.7-3H3" />
    <path d="M3 21v-6h6" />
  </svg>
);
const IconEmpty = ({ size = 34 }: IconProps) => (
  <svg {...iconAttrs(size, 1.6)}>
    <path d="M22 12h-6l-2 3h-4l-2-3H2" />
    <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
  </svg>
);

// ─── Helpers ──────────────────────────────────────────────────────────────

/** "3 days" / "today" — how long this piece has sat where it is. */
function ageLabel(iso: string | null): string | null {
  if (!iso) return null;
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "1 day";
  return `${days} days`;
}

/**
 * "just now" / "6 min ago" / "2 h ago" — how current the cached order list is.
 * Minute granularity, unlike ageLabel, which measures days in a stage.
 */
function freshnessLabel(iso: string): string {
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  if (mins < 1) return "just now";
  if (mins === 1) return "1 min ago";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  return hours === 1 ? "1 h ago" : `${hours} h ago`;
}

/**
 * Total pieces across a set of lines.
 *
 * A line's quantity can exceed 1, so the number of CARDS and the number of
 * PIECES are different figures. The pick list reports pieces; the board is
 * organised by line. Both are shown everywhere so they reconcile.
 */
function pieces(lines: TrackedLine[]): number {
  return lines.reduce((sum, l) => sum + l.quantity, 0);
}

function shopifyImg(url: string | null, size: number): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    u.searchParams.set("width", String(size));
    return u.toString();
  } catch {
    return url;
  }
}

// ─── Component ────────────────────────────────────────────────────────────

export default function TrackPage() {
  const fetcher = useFetcher<typeof action>();

  // Board data arrives after this page renders — see app.track.board.
  const board = useFetcher<typeof boardLoader>();
  const loadedRef = useRef(false);
  useEffect(() => {
    if (loadedRef.current) return;
    loadedRef.current = true;
    board.load(BOARD_ROUTE);
  }, [board]);

  /**
   * Memoised deliberately. `board.data?.lines ?? []` would hand back a NEW
   * empty array on every render while the data is still loading, and `lines`
   * is a dependency of the effect that clears optimistic overrides — so each
   * render would set state, re-render, and loop forever. Keyed on board.data,
   * the fallback array stays identical between renders.
   */
  const lines = useMemo(() => board.data?.lines ?? [], [board.data]);
  const error = board.data?.error ?? null;
  const loadingBoard = board.state === "loading" || board.data === undefined;

  /**
   * Refresh forces a real Shopify read (?force=1), bypassing the cache.
   * The plain load used on mount is happy to be served from it.
   */
  const refresh = useCallback(
    () => board.load(`${BOARD_ROUTE}?force=1`),
    [board]
  );

  const [search, setSearch] = useState("");
  // Promised-date range. Either bound may be empty, meaning unbounded.
  const [dueFrom, setDueFrom] = useState("");
  const [dueTo, setDueTo] = useState("");
  const [mobileColumn, setMobileColumn] = useState<BoardColumn | "ALL">("ALL");
  const [editing, setEditing] = useState<TrackedLine | null>(null);

  /**
   * Changes applied on screen before the server confirms them. This is what
   * makes the board usable on a phone: a tap moves the card instantly instead
   * of waiting on a round-trip. Cleared whenever fresh loader data arrives,
   * at which point the server is the truth again.
   */
  const [overrides, setOverrides] = useState<
    Map<
      string,
      Partial<Pick<TrackedLine, "status" | "stage" | "promisedDate" | "note">>
    >
  >(new Map());
  const [saveError, setSaveError] = useState<string | null>(null);

  /**
   * Pending submissions, drained one at a time.
   *
   * A single fetcher aborts whatever is in flight when you submit again, so
   * firing on every tap could drop a change — or land two out of order and
   * leave the database showing an earlier stage than the screen. Serialising
   * keeps writes ordered; each POST is small, so the queue drains fast.
   */
  const queue = useRef<Array<Record<string, string>>>([]);
  const [drainTick, setDrainTick] = useState(0);

  useEffect(() => {
    if (fetcher.state !== "idle" || queue.current.length === 0) return;
    fetcher.submit(queue.current.shift()!, { method: "POST" });
  }, [fetcher, fetcher.state, drainTick]);

  const enqueue = (fields: Record<string, string>) => {
    queue.current.push(fields);
    setDrainTick((n) => n + 1);
  };

  const pendingWrites = fetcher.state !== "idle" || queue.current.length > 0;

  /**
   * A failed write means the screen and the database now disagree, and we
   * can't know which queued changes survived. Drop every optimistic change and
   * re-read rather than leaving a plausible-looking lie on screen.
   *
   * The ref matters: fetcher.data KEEPS the failure response after the fetcher
   * goes idle, so without it this effect re-fires on the re-render its own
   * revalidate() causes — an endless loop of full Shopify sweeps. Guarding on
   * the response's identity handles each failure exactly once, and a later
   * successful write replaces the object so the next failure is seen again.
   */
  const handledFailure = useRef<unknown>(null);
  useEffect(() => {
    if (fetcher.state !== "idle") return;
    const data = fetcher.data;
    if (!data || data.ok !== false) return;
    if (handledFailure.current === data) return;

    handledFailure.current = data;
    queue.current = [];
    setOverrides(new Map());
    setSaveError(data.error ?? "Couldn't save that change.");
    refresh();
  }, [fetcher.state, fetcher.data, refresh]);

  /** Loader data is authoritative — discard the optimistic layer. */
  useEffect(() => {
    setOverrides(new Map());
  }, [lines]);

  const effectiveLines: TrackedLine[] = useMemo(() => {
    if (overrides.size === 0) return lines;
    return lines.map((l) => {
      const o = overrides.get(l.lineItemId);
      if (!o) return l;
      const status = "status" in o ? o.status! : l.status;
      const stage = "stage" in o ? o.stage! : l.stage;
      return {
        ...l,
        status,
        stage,
        promisedDate:
          "promisedDate" in o ? o.promisedDate! : l.promisedDate,
        note: "note" in o ? o.note! : l.note,
        column: columnFor(status, stage),
      };
    });
  }, [lines, overrides]);

  // Saving a promised date leaves the sheet open, so keep the item it shows in
  // step with the board. The functional form means this needs no dependency on
  // `editing` and so can't loop.
  useEffect(() => {
    setEditing((cur) =>
      cur
        ? (effectiveLines.find((l) => l.lineItemId === cur.lineItemId) ?? cur)
        : cur
    );
  }, [effectiveLines]);

  // Escape closes the editor, as any dialog should.
  useEffect(() => {
    if (!editing) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setEditing(null);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [editing]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const ranged = Boolean(dueFrom || dueTo);
    if (!q && !ranged) return effectiveLines;

    return effectiveLines.filter((l) => {
      // A range excludes anything with no promised date — an undated piece
      // isn't "due in this window", it has no due date at all.
      if (ranged && !withinDateRange(l.promisedDate, dueFrom, dueTo)) {
        return false;
      }
      if (!q) return true;
      return (
        l.productTitle.toLowerCase().includes(q) ||
        l.variantTitle.toLowerCase().includes(q) ||
        l.orderName.toLowerCase().includes(q) ||
        (l.sku ?? "").toLowerCase().includes(q) ||
        (l.note ?? "").toLowerCase().includes(q)
      );
    });
  }, [effectiveLines, search, dueFrom, dueTo]);

  const byColumn = useMemo(() => {
    const map = new Map<BoardColumn, TrackedLine[]>();
    for (const col of BOARD_COLUMNS) map.set(col, []);
    for (const line of filtered) map.get(line.column)!.push(line);
    return map;
  }, [filtered]);

  const inManufactureLines = filtered.filter(
    (l) => l.column !== UNTRIAGED && l.column !== "READY_TO_SHIP"
  );

  /** The Shopify snapshot every write carries — see the action for why. */
  const snapshotOf = (line: TrackedLine): Record<string, string> => ({
    lineItemId: line.lineItemId,
    orderId: line.orderId,
    orderName: line.orderName,
    orderCreatedAt: line.orderCreatedAt,
    productId: line.productId,
    productTitle: line.productTitle,
    productType: line.productType,
    variantId: line.variantId,
    variantTitle: line.variantTitle,
    sku: line.sku ?? "",
    quantity: String(line.quantity),
    imageUrl: line.imageUrl ?? "",
  });

  /** Move a piece. The card jumps immediately; the write follows. */
  const move = (
    line: TrackedLine,
    status: TrackStatus | null,
    stage: TrackStage | null
  ) => {
    setSaveError(null);
    setOverrides((m) => new Map(m).set(line.lineItemId, { status, stage }));
    enqueue({
      ...snapshotOf(line),
      intent: "status",
      // "" means untriaged — the revert target.
      status: status ?? "",
      stage: stage ?? "",
    });
    setEditing(null);
  };

  const advance = (line: TrackedLine) => {
    if (line.column === UNTRIAGED) {
      move(line, "IN_MANUFACTURE", STAGES[0]);
      return;
    }
    if (line.stage) {
      const { status, stage } = nextStep(line.stage);
      move(line, status, stage);
    }
  };

  /** One step back along the chain; no-op at Untriaged. */
  const revert = (line: TrackedLine) => {
    const back = prevStep(line.column);
    if (back) move(line, back.status, back.stage);
  };

  /** Save the promised date, the note, or both. Omitted fields are untouched. */
  const saveDetails = (
    line: TrackedLine,
    patch: { promisedDate?: string; note?: string }
  ) => {
    setSaveError(null);
    setOverrides((m) => {
      const next = new Map(m);
      const cur = next.get(line.lineItemId) ?? {};
      next.set(line.lineItemId, {
        ...cur,
        ...(patch.promisedDate !== undefined
          ? { promisedDate: patch.promisedDate || null }
          : {}),
        ...(patch.note !== undefined
          ? { note: patch.note.trim() || null }
          : {}),
      });
      return next;
    });
    enqueue({
      ...snapshotOf(line),
      intent: "details",
      ...(patch.promisedDate !== undefined
        ? { promisedDate: patch.promisedDate }
        : {}),
      ...(patch.note !== undefined ? { note: patch.note } : {}),
    });
  };

  const visibleColumns =
    mobileColumn === "ALL" ? BOARD_COLUMNS : [mobileColumn];

  return (
    <>
      <style>{TRACK_CSS}</style>

      <div className="tk-app">
        <div className="tk-page">
          {/* Header */}
          <header className="tk-header">
            <div>
              <p className="tk-eyebrow">Vellismith · Production</p>
              <h1>Track</h1>
            </div>
            <div className="tk-head-actions">
              {/* Writes happen in the background; this just reassures, it
                  never blocks the board. */}
              {pendingWrites && <span className="tk-saving">Saving…</span>}
              {/* State the data's age plainly. The cache means the order list
                  can be a few minutes behind, and a board that quietly lies
                  about how current it is would be worse than a slow one.
                  (Tracking statuses are never cached — always live.) */}
              {!loadingBoard && board.data?.fetchedAt && (
                <span
                  className="tk-freshness"
                  title={
                    board.data.cached
                      ? "Order list served from cache. Refresh re-reads Shopify."
                      : "Order list read from Shopify just now."
                  }
                >
                  Orders {freshnessLabel(board.data.fetchedAt)}
                </span>
              )}
              <button
                className="btn btn-secondary"
                onClick={refresh}
                disabled={board.state !== "idle"}
              >
                <IconRefresh />
                {board.state !== "idle" ? "Refreshing…" : "Refresh"}
              </button>
            </div>
          </header>

          {/* Stats.
              Every figure is stated twice — order lines AND pieces — because
              they differ: one line for three rings is 1 line but 3 pieces.
              The pick list counts pieces ("Items to pick"), so showing both
              makes the two pages reconcile at a glance instead of looking
              like a discrepancy. */}
          <div className="tk-stats">
            {(
              [
                ["Open lines", filtered, false],
                ["In manufacture", inManufactureLines, true],
                ["Ready to ship", byColumn.get("READY_TO_SHIP") ?? [], false],
                ["Untriaged", byColumn.get(UNTRIAGED) ?? [], false],
              ] as Array<[string, TrackedLine[], boolean]>
            ).map(([label, group, accent], i, all) => (
              <div key={label} className={i === all.length - 1 ? "tk-stat-last" : undefined}>
                <div className={accent ? "tk-stat-n tk-accent" : "tk-stat-n"}>
                  {group.length.toLocaleString()}
                </div>
                <div className="tk-stat-l">
                  {label === "Open lines" ? "Order lines" : label}
                </div>
                <div className="tk-stat-sub">
                  {pieces(group).toLocaleString()} pieces
                </div>
              </div>
            ))}
          </div>

          {/* Explains the two figures once, so nobody has to reverse-engineer
              why the pick list's total is larger than the card count. */}
          <p className="tk-legend">
            An order line can be for several pieces, so counts read{" "}
            <b>lines/pieces</b>. The pick list totals <b>pieces</b>.
          </p>

          {/* Search + promised-date range */}
          <div className="tk-toolbar">
            <input
              className="input tk-search"
              placeholder="Search product, variant, SKU, order or note…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <div className="tk-due-filter">
              <label>
                <span>Promised from</span>
                <input
                  className="input"
                  type="date"
                  value={dueFrom}
                  max={dueTo || undefined}
                  onChange={(e) => setDueFrom(e.target.value)}
                />
              </label>
              <label>
                <span>to</span>
                <input
                  className="input"
                  type="date"
                  value={dueTo}
                  min={dueFrom || undefined}
                  onChange={(e) => setDueTo(e.target.value)}
                />
              </label>
              {(dueFrom || dueTo) && (
                <button
                  className="tk-clear-due"
                  onClick={() => {
                    setDueFrom("");
                    setDueTo("");
                  }}
                >
                  Clear
                </button>
              )}
            </div>
          </div>

          {/* An active range hides undated work entirely, which would
              otherwise look like items had vanished. Say so. */}
          {(dueFrom || dueTo) && (
            <p className="tk-legend">
              Showing only pieces with a promised date in range — undated
              pieces are hidden.
            </p>
          )}

          {/* Mobile column chips */}
          <div className="tk-chips">
            <button
              className={mobileColumn === "ALL" ? "tk-chip on" : "tk-chip"}
              onClick={() => setMobileColumn("ALL")}
            >
              All ({filtered.length})
            </button>
            {BOARD_COLUMNS.map((col) => (
              <button
                key={col}
                className={mobileColumn === col ? "tk-chip on" : "tk-chip"}
                onClick={() => setMobileColumn(col)}
              >
                {COLUMN_LABELS[col]} ({byColumn.get(col)?.length ?? 0})
              </button>
            ))}
          </div>

          {(error || saveError) && (
            <div className="tk-error">{error ?? saveError}</div>
          )}

          {/* Board */}
          {loadingBoard ? (
            /* The page itself is already on screen; only the board is still
               coming. Skeleton columns keep the layout stable so nothing
               jumps when the data lands. */
            <div className="tk-board" aria-busy="true">
              {BOARD_COLUMNS.slice(0, 4).map((col) => (
                <section key={col} className="tk-col">
                  <header className="tk-col-head">
                    <span className="tk-col-name">{COLUMN_LABELS[col]}</span>
                  </header>
                  <div className="tk-col-body">
                    <div className="tk-skel" />
                    <div className="tk-skel" />
                  </div>
                </section>
              ))}
            </div>
          ) : filtered.length === 0 && !error ? (
            <div className="tk-empty">
              <IconEmpty />
              <p>
                {lines.length === 0
                  ? "No unfulfilled orders right now — nothing to track."
                  : "No lines match that search."}
              </p>
            </div>
          ) : (
            <div className="tk-board" data-all={mobileColumn === "ALL"}>
              {visibleColumns.map((col) => {
                const items = byColumn.get(col) ?? [];
                return (
                  <section
                    key={col}
                    className="tk-col"
                    data-col={col}
                    // On a phone showing every column, empty ones are just
                    // dead scrolling — CSS hides them (desktop keeps them, so
                    // the board's shape stays stable).
                    data-empty={items.length === 0}
                  >
                    <header className="tk-col-head">
                      <span className="tk-col-name">{COLUMN_LABELS[col]}</span>
                      {/* cards · pieces — same reason as the stats bar. */}
                      <span
                        className="tk-col-count"
                        title={`${items.length} order lines · ${pieces(items)} pieces`}
                      >
                        {items.length}
                        <span className="tk-col-pcs">/{pieces(items)}</span>
                      </span>
                    </header>

                    <div className="tk-col-body">
                      {items.length === 0 ? (
                        <p className="tk-col-empty">—</p>
                      ) : (
                        items.map((line) => (
                          <div
                            key={line.lineItemId}
                            className="tk-card"
                            onClick={() => setEditing(line)}
                            role="button"
                            tabIndex={0}
                            onKeyDown={(e) => {
                              if (e.key === "Enter" || e.key === " ") {
                                e.preventDefault();
                                setEditing(line);
                              }
                            }}
                          >
                            <div className="tk-card-top">
                              {shopifyImg(line.imageUrl, 120) ? (
                                <img
                                  src={shopifyImg(line.imageUrl, 120)!}
                                  alt=""
                                  loading="lazy"
                                />
                              ) : (
                                <div className="tk-noimg" />
                              )}
                              <div className="tk-card-txt">
                                <p className="tk-card-title">
                                  {line.productTitle}
                                </p>
                                <p className="tk-card-var">
                                  {line.variantTitle}
                                </p>
                              </div>
                              <span className="tk-qty">{line.quantity}</span>
                            </div>

                            <div className="tk-card-foot">
                              <span className="tk-order">{line.orderName}</span>
                              {line.promisedDate && (
                                <span
                                  className="tk-due"
                                  title={
                                    `Promised ${line.promisedDate}` +
                                    (line.note ? ` — ${line.note}` : "")
                                  }
                                >
                                  {formatPromisedDate(line.promisedDate)}
                                  {line.note ? " *" : ""}
                                </span>
                              )}
                              {ageLabel(line.updatedAt) && (
                                <span className="tk-age">
                                  {ageLabel(line.updatedAt)}
                                </span>
                              )}

                              {col === UNTRIAGED ? (
                                /* Triage: the only two choices at intake. */
                                <span className="tk-flags">
                                  <button
                                    className="tk-flag"
                                                                        title="Send straight to Ready to ship"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      move(line, "READY_TO_SHIP", null);
                                    }}
                                  >
                                    Ship
                                  </button>
                                  <button
                                    className="tk-flag tk-flag-make"
                                                                        title="Start manufacturing at Design"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      move(line, "IN_MANUFACTURE", STAGES[0]);
                                    }}
                                  >
                                    Make
                                  </button>
                                </span>
                              ) : (
                                <span className="tk-flags">
                                  <button
                                    className="tk-next"
                                                                        title="Move back a step"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      revert(line);
                                    }}
                                  >
                                    <IconArrow back />
                                  </button>
                                  {col !== "READY_TO_SHIP" && (
                                    <button
                                      className="tk-next"
                                                                            title="Advance to next stage"
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        advance(line);
                                      }}
                                    >
                                      <IconArrow />
                                    </button>
                                  )}
                                </span>
                              )}
                            </div>
                          </div>
                        ))
                      )}
                    </div>
                  </section>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Editor sheet */}
      {editing && (
        <>
          <button
            type="button"
            className="tk-backdrop"
            aria-label="Close"
            onClick={() => setEditing(null)}
          />
          <div className="tk-sheet" role="dialog" aria-label="Set status">
            <div className="tk-sheet-head">
              <div>
                <p className="tk-sheet-title">{editing.productTitle}</p>
                <p className="tk-sheet-sub">
                  {editing.variantTitle} · {editing.orderName} · ×
                  {editing.quantity}
                </p>
              </div>
              <button
                className="tk-close"
                onClick={() => setEditing(null)}
                aria-label="Close"
              >
                <IconX />
              </button>
            </div>

            <div className="tk-sheet-body">
              {/* Free-text note of when the customer wants it. Saved on its
                  own, so recording it at intake doesn't force a triage
                  decision first. Saves on blur — a text field saving per
                  keystroke would write to the database on every letter.
                  `key` re-seeds the field when a different item is opened. */}
              <p className="tk-group-label">Promised date</p>
              <input
                key={`d-${editing.lineItemId}`}
                className="input"
                type="date"
                defaultValue={editing.promisedDate ?? ""}
                onChange={(e) =>
                  saveDetails(editing, { promisedDate: e.target.value })
                }
              />

              {/* Free-form context, so the date field can stay a real date and
                  still capture "before Diwali, customer travelling". Saved on
                  blur — per-keystroke would write on every letter typed. */}
              <p className="tk-group-label">Note</p>
              <input
                key={`n-${editing.lineItemId}`}
                className="input"
                type="text"
                placeholder="e.g. before Diwali, customer travelling…"
                maxLength={NOTE_MAX}
                defaultValue={editing.note ?? ""}
                onBlur={(e) => {
                  if (e.target.value.trim() !== (editing.note ?? "")) {
                    saveDetails(editing, { note: e.target.value });
                  }
                }}
              />

              <p className="tk-group-label">Status</p>
              <button
                className={editing.column === UNTRIAGED ? "tk-opt on" : "tk-opt"}
                                onClick={() => move(editing, null, null)}
              >
                Untriaged
              </button>
              <button
                className={
                  editing.status === "READY_TO_SHIP"
                    ? "tk-opt on"
                    : "tk-opt"
                }
                                onClick={() => move(editing, "READY_TO_SHIP", null)}
              >
                Ready to ship
              </button>

              <p className="tk-group-label">In manufacture</p>
              {STAGES.map((stage) => (
                <button
                  key={stage}
                  className={
                    editing.status === "IN_MANUFACTURE" &&
                    editing.stage === stage
                      ? "tk-opt on"
                      : "tk-opt"
                  }
                                    onClick={() => move(editing, "IN_MANUFACTURE", stage)}
                >
                  {STAGE_LABELS[stage]}
                </button>
              ))}
            </div>
          </div>
        </>
      )}
    </>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────

const TRACK_CSS = `
@import url('https://fonts.googleapis.com/css2?family=Archivo:wght@400;600;800&display=swap');

.tk-app {
  --color-bg: #f3f2f2;
  --color-surface: #eae9e9;
  --color-text: #201e1d;
  --color-accent: #ec3013;
  --color-divider: color-mix(in srgb, #201e1d 40%, transparent);
  --color-neutral-600: #7d7979;
  --font-heading: "Archivo", system-ui, sans-serif;
  --font-body: "Archivo", system-ui, sans-serif;

  background: var(--color-bg);
  color: var(--color-text);
  font-family: var(--font-body);
  font-size: 15px;
  line-height: 1.55;
  min-height: 100vh;
  /* Same overflow guard as the pick list: one over-wide element would expand
     the mobile viewport and stop the breakpoints below from ever matching. */
  max-width: 100%;
  overflow-x: hidden;
}
.tk-app *, .tk-app *::before, .tk-app *::after { box-sizing: border-box; }
.tk-app img { max-width: 100%; }

.tk-page { max-width: 1400px; margin: 0 auto; padding: 30px 24px 60px; }

.tk-header {
  display: flex; align-items: flex-end; justify-content: space-between;
  gap: 16px; padding-bottom: 18px; border-bottom: 2px solid var(--color-divider);
}
.tk-eyebrow {
  font-family: var(--font-heading); font-weight: 800; font-size: 11px;
  letter-spacing: .12em; text-transform: uppercase; color: var(--color-accent);
  margin: 0 0 6px;
}
.tk-header h1 {
  font-family: var(--font-heading); font-weight: 800; font-size: 44px;
  letter-spacing: -.02em; line-height: 1; margin: 0;
}

.tk-app .btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 7px;
  font-family: var(--font-heading); font-weight: 800; font-size: 13px;
  padding: 10px 18px; border-radius: 0; border: 1px solid var(--color-divider);
  background: transparent; color: var(--color-text); cursor: pointer;
}
.tk-app .btn:disabled { opacity: .55; cursor: default; }
.tk-head-actions { display: flex; align-items: center; gap: 10px; flex: none; }
.tk-freshness {
  font-size: 11px; color: var(--color-neutral-600); white-space: nowrap;
}
.tk-saving {
  font-family: var(--font-heading); font-weight: 800; font-size: 11px;
  letter-spacing: .08em; text-transform: uppercase; color: var(--color-accent);
  animation: tkPulse 1.1s ease-in-out infinite;
}
@keyframes tkPulse { 0%,100% { opacity: .45; } 50% { opacity: 1; } }
.tk-app .btn-secondary:hover:not(:disabled) {
  background: color-mix(in srgb, var(--color-text) 7%, transparent);
}

.tk-stats {
  display: flex; flex-wrap: wrap; border-bottom: 2px solid var(--color-divider);
}
.tk-stats > div {
  flex: 1 1 120px; padding: 18px 20px;
  border-right: 1px solid var(--color-divider);
}
.tk-stats > div.tk-stat-last { border-right: none; }
.tk-stat-n {
  font-family: var(--font-heading); font-weight: 800; font-size: 36px; line-height: 1;
}
.tk-stat-n.tk-accent { color: var(--color-accent); }
.tk-stat-l {
  font-size: 11px; letter-spacing: .1em; text-transform: uppercase;
  color: var(--color-neutral-600); margin-top: 6px;
}
/* The piece count under each line count — the figure the pick list reports. */
.tk-stat-sub {
  font-family: var(--font-heading); font-weight: 800; font-size: 11px;
  color: var(--color-text); margin-top: 3px;
}
.tk-col-pcs { opacity: .5; font-weight: 800; }
.tk-legend {
  font-size: 11px; color: var(--color-neutral-600); padding: 10px 0 0;
}
.tk-legend b { font-family: var(--font-heading); color: var(--color-text); }

.tk-toolbar {
  padding: 18px 0; display: flex; gap: 14px; align-items: flex-end; flex-wrap: wrap;
}
.tk-search { flex: 1 1 280px; }
.tk-due-filter { display: flex; gap: 10px; align-items: flex-end; flex-wrap: wrap; }
.tk-due-filter label { display: flex; flex-direction: column; gap: 4px; }
.tk-due-filter label > span {
  font-size: 11px; letter-spacing: .06em; text-transform: uppercase;
  color: var(--color-neutral-600);
}
.tk-due-filter .input { width: auto; min-width: 150px; }
.tk-clear-due {
  font-family: var(--font-heading); font-weight: 800; font-size: 12px;
  padding: 9px 12px; border: 1px solid var(--color-divider);
  background: transparent; color: var(--color-accent); cursor: pointer;
}
.tk-app .input {
  width: 100%; min-height: 40px; padding: 8px 12px; font: inherit; font-size: 14px;
  color: var(--color-text); background: var(--color-surface);
  border: 1px solid var(--color-divider); border-radius: 0;
}
.tk-app .input:focus-visible { border-color: var(--color-accent); outline: none; }

/* Column chips — a mobile affordance, hidden on wide screens where the full
   board is visible anyway. */
.tk-chips { display: none; gap: 8px; flex-wrap: wrap; padding-bottom: 16px; }
.tk-chip {
  font-family: var(--font-heading); font-weight: 800; font-size: 12px;
  padding: 8px 12px; border: 1px solid var(--color-divider);
  background: transparent; color: var(--color-text); cursor: pointer;
}
.tk-chip.on { background: var(--color-text); color: var(--color-bg); border-color: var(--color-text); }

.tk-error {
  border: 1px solid var(--color-accent); background: #fff2ef;
  color: #7c1405; padding: 12px 14px; font-size: 14px; margin-bottom: 16px;
}

.tk-empty {
  display: flex; flex-direction: column; align-items: center; gap: 14px;
  padding: 70px 20px; color: var(--color-neutral-600); text-align: center;
  border: 1px solid var(--color-divider); background: var(--color-surface);
}
.tk-empty p { margin: 0; font-size: 15px; }

/* Board: columns scroll horizontally rather than squeezing to nothing. */
.tk-board {
  display: flex; gap: 14px; align-items: flex-start;
  overflow-x: auto; padding-bottom: 14px;
}
.tk-col {
  flex: 0 0 235px; background: var(--color-surface);
  border: 1px solid var(--color-divider);
}
.tk-col[data-col="READY_TO_SHIP"] { border-color: var(--color-text); }
.tk-col-head {
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  padding: 11px 12px; border-bottom: 2px solid var(--color-divider);
}
.tk-col-name {
  font-family: var(--font-heading); font-weight: 800; font-size: 12px;
  letter-spacing: .08em; text-transform: uppercase;
}
.tk-col-count {
  font-family: var(--font-heading); font-weight: 800; font-size: 12px;
  color: var(--color-accent);
}
.tk-col-body { padding: 10px; display: flex; flex-direction: column; gap: 10px; }
.tk-col-empty { margin: 0; padding: 10px 2px; color: var(--color-neutral-600); }
.tk-skel {
  height: 74px; background: var(--color-bg);
  border: 1px solid var(--color-divider); animation: tkPulse 1.3s ease-in-out infinite;
}

.tk-card {
  background: var(--color-bg); border: 1px solid var(--color-divider);
  padding: 10px; cursor: pointer; transition: box-shadow 160ms ease;
}
.tk-card:hover { box-shadow: 0 3px 10px color-mix(in srgb, #2d2b2b 16%, transparent); }
.tk-card-top { display: flex; gap: 9px; align-items: flex-start; }
.tk-card img, .tk-noimg {
  width: 40px; height: 40px; object-fit: cover; flex: none;
  border: 1px solid var(--color-divider); background: var(--color-surface);
}
.tk-card-txt { min-width: 0; flex: 1 1 auto; }
.tk-card-title {
  font-family: var(--font-heading); font-weight: 800; font-size: 13px;
  line-height: 1.25; margin: 0 0 2px; overflow-wrap: anywhere;
}
.tk-card-var {
  margin: 0; font-size: 12px; color: var(--color-neutral-600);
  overflow-wrap: anywhere;
}
.tk-qty {
  font-family: var(--font-heading); font-weight: 800; font-size: 17px;
  color: var(--color-accent); flex: none;
}
.tk-card-foot {
  display: flex; align-items: center; gap: 8px; margin-top: 9px;
  padding-top: 8px; border-top: 1px solid var(--color-divider);
}
.tk-order {
  font-family: var(--font-heading); font-weight: 800; font-size: 11px;
}
.tk-age { font-size: 11px; color: var(--color-neutral-600); }

/* The customer's requested date, shown as typed. Kept to one line so a long
   note can't stretch the card. */
.tk-due {
  font-family: var(--font-heading); font-weight: 800; font-size: 11px;
  color: var(--color-neutral-600);
  max-width: 90px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}

.tk-flags { margin-left: auto; display: inline-flex; gap: 5px; flex: none; }

/* Triage flags, shown only on untriaged cards. */
.tk-flag {
  font-family: var(--font-heading); font-weight: 800; font-size: 11px;
  padding: 5px 9px; border: 1px solid var(--color-divider);
  background: transparent; color: var(--color-text); cursor: pointer;
}
.tk-flag:hover:not(:disabled) { border-color: var(--color-text); }
.tk-flag-make:hover:not(:disabled) {
  background: var(--color-accent); border-color: var(--color-accent); color: #fff;
}
.tk-flag:disabled { opacity: .4; cursor: default; }

.tk-next {
  display: inline-flex; align-items: center;
  justify-content: center; width: 28px; height: 28px; flex: none;
  border: 1px solid var(--color-divider); background: transparent;
  color: var(--color-text); cursor: pointer;
}
.tk-next:hover:not(:disabled) {
  background: var(--color-accent); border-color: var(--color-accent); color: #fff;
}
.tk-next:disabled { opacity: .4; cursor: default; }

/* Editor sheet — centred dialog on desktop, bottom sheet on phones. */
.tk-backdrop {
  position: fixed; inset: 0; background: rgba(0,0,0,.45); z-index: 900;
  border: none; padding: 0; cursor: pointer;
}
.tk-sheet {
  position: fixed; z-index: 901; background: #f3f2f2; color: #201e1d;
  font-family: "Archivo", system-ui, sans-serif;
  border: 1px solid #201e1d;
  top: 50%; left: 50%; transform: translate(-50%, -50%);
  width: min(420px, calc(100vw - 40px)); max-height: 84vh;
  display: flex; flex-direction: column;
  box-shadow: 0 12px 32px rgba(45,43,43,.3);
}
.tk-sheet-head {
  display: flex; align-items: flex-start; justify-content: space-between;
  gap: 12px; padding: 16px; border-bottom: 2px solid #201e1d;
}
.tk-sheet-title { font-weight: 800; font-size: 15px; margin: 0 0 3px; line-height: 1.25; }
.tk-sheet-sub { margin: 0; font-size: 12px; color: #7d7979; }
.tk-close {
  flex: none; background: transparent; border: none; cursor: pointer;
  color: #201e1d; padding: 2px; display: inline-flex;
}
.tk-sheet-body { padding: 12px; overflow-y: auto; }
.tk-group-label {
  font-weight: 800; font-size: 10px; letter-spacing: .12em;
  text-transform: uppercase; color: #7d7979; margin: 10px 4px 7px;
}
.tk-group-label:first-child { margin-top: 2px; }
.tk-opt {
  display: block; width: 100%; text-align: left; font-family: inherit;
  font-weight: 800; font-size: 14px; padding: 12px 14px; margin-bottom: 6px;
  background: #eae9e9; border: 1px solid rgba(32,30,29,.4);
  color: #201e1d; cursor: pointer;
}
.tk-opt:hover:not(:disabled) { border-color: #201e1d; }
.tk-opt.on { background: #ec3013; border-color: #ec3013; color: #fff; }
.tk-opt:disabled { opacity: .55; cursor: default; }

@media (max-width: 860px) {
  .tk-page { padding: 22px 16px 44px; }
  .tk-header { flex-direction: column; align-items: stretch; gap: 14px; }
  .tk-header h1 { font-size: 32px; }
  .tk-head-actions { justify-content: space-between; }
  .tk-app .btn { flex: 1 1 auto; min-height: 44px; }
  .tk-stats > div { flex: 1 1 50%; padding: 14px 12px; }
  /* Two per row: give the first two a bottom rule and drop the dangling
     right border so the 2x2 grid reads as a grid. */
  .tk-stats > div:nth-child(2n) { border-right: none; }
  .tk-stats > div:nth-child(-n+2) { border-bottom: 1px solid var(--color-divider); }
  .tk-stat-n { font-size: 26px; }

  /* Chips become a single swipeable row and stay pinned while the board
     scrolls, so switching stage never means scrolling back to the top. */
  .tk-chips {
    display: flex; flex-wrap: nowrap; overflow-x: auto; padding: 10px 0;
    position: sticky; top: 0; z-index: 5; background: var(--color-bg);
    border-bottom: 1px solid var(--color-divider);
    scrollbar-width: none; -webkit-overflow-scrolling: touch;
  }
  .tk-chips::-webkit-scrollbar { display: none; }
  .tk-chip { flex: none; min-height: 38px; white-space: nowrap; }

  /* One column at a time on phones — the chips choose which. */
  .tk-board { flex-direction: column; overflow-x: visible; }
  .tk-col { flex: 1 1 auto; width: 100%; }
  /* Viewing everything: skip empty stages rather than scrolling past them. */
  .tk-board[data-all="true"] .tk-col[data-empty="true"] { display: none; }

  /* Long product names and free-text dates must never widen a card. */
  .tk-card-foot { flex-wrap: wrap; row-gap: 6px; }
  .tk-due { max-width: 45vw; }
  .tk-app .input { min-height: 44px; }
  .tk-next { width: 34px; height: 34px; }
  /* Two date inputs side by side don't fit a phone — give each half a row. */
  .tk-toolbar { gap: 10px; }
  .tk-search { flex: 1 1 100%; }
  .tk-due-filter { width: 100%; gap: 8px; }
  .tk-due-filter label { flex: 1 1 0; min-width: 0; }
  .tk-due-filter .input { width: 100%; min-width: 0; }
  .tk-clear-due { min-height: 44px; flex: none; }
  /* Bigger triage targets for thumbs. */
  .tk-flag { padding: 8px 12px; font-size: 12px; }

  /* Editor becomes a bottom sheet. */
  .tk-sheet {
    top: auto; left: 0; right: 0; bottom: 0; transform: none;
    width: 100%; max-height: 82vh; border: none; border-top: 2px solid #201e1d;
    padding-bottom: env(safe-area-inset-bottom, 0px);
  }
}
`;
