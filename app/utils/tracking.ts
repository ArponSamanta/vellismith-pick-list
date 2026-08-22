/**
 * Shared vocabulary for the production tracker.
 *
 * Imported by BOTH server and client, so it must stay free of any node-only
 * dependency. These are plain strings rather than Prisma enums on purpose:
 * the workshop's stage list is the kind of thing that changes (add "Quality
 * check", reorder two steps), and a string column lets that be a one-line
 * edit here instead of a database migration.
 */

// ── Status ────────────────────────────────────────────────────────────────
// The top-level decision for an ordered line: do we already have the piece,
// or must it be made? READY_TO_SHIP is both the triage answer ("it's in the
// case") and the finish line (Plating completed).

export const STATUSES = ["IN_MANUFACTURE", "READY_TO_SHIP"] as const;
export type TrackStatus = (typeof STATUSES)[number];

export const STATUS_LABELS: Record<TrackStatus, string> = {
  IN_MANUFACTURE: "In manufacture",
  READY_TO_SHIP: "Ready to ship",
};

// ── Stages ────────────────────────────────────────────────────────────────
// Only meaningful while status is IN_MANUFACTURE. Order matters: it drives
// the board's column order and the "advance to next stage" action.

export const STAGES = [
  "DESIGN",
  "CASTING",
  "WORKSHOP",
  "SETTING",
  "POLISHING",
  "PLATING",
] as const;
export type TrackStage = (typeof STAGES)[number];

export const STAGE_LABELS: Record<TrackStage, string> = {
  DESIGN: "Design",
  CASTING: "Casting",
  WORKSHOP: "Workshop",
  SETTING: "Setting",
  POLISHING: "Polishing",
  PLATING: "Plating",
};

/** An order line Shopify still owes that nobody has triaged yet. */
export const UNTRIAGED = "UNTRIAGED" as const;

/**
 * Every board column, left to right: untriaged work, then the manufacturing
 * stages in order, then the finished pile.
 */
export const BOARD_COLUMNS = [UNTRIAGED, ...STAGES, "READY_TO_SHIP"] as const;
export type BoardColumn = (typeof BOARD_COLUMNS)[number];

export const COLUMN_LABELS: Record<BoardColumn, string> = {
  [UNTRIAGED]: "Untriaged",
  ...STAGE_LABELS,
  READY_TO_SHIP: "Ready to ship",
};

// ── Transitions ───────────────────────────────────────────────────────────

// ── Promised date ─────────────────────────────────────────────────────────
// Free text, exactly as typed — "15 Sep", "before Diwali", "end of month".
// It's a note about when the customer wants the piece, not a machine-read
// date, so nothing parses or validates it. The only rule is a length cap so a
// stray paste can't bloat the row.

export const PROMISED_DATE_MAX = 120;

/** Trim and cap. Empty (or whitespace-only) means "no date recorded". */
export function cleanPromisedDate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().slice(0, PROMISED_DATE_MAX);
  return trimmed === "" ? null : trimmed;
}

export function isStage(value: unknown): value is TrackStage {
  return typeof value === "string" && (STAGES as readonly string[]).includes(value);
}

export function isStatus(value: unknown): value is TrackStatus {
  return typeof value === "string" && (STATUSES as readonly string[]).includes(value);
}

/**
 * What "advance" means from a given stage. Finishing the last stage
 * (Plating) completes the piece, so it flips status to READY_TO_SHIP rather
 * than moving to another stage — the finish-line behaviour.
 */
export function nextStep(
  stage: TrackStage
): { status: TrackStatus; stage: TrackStage | null } {
  const i = STAGES.indexOf(stage);
  const next = STAGES[i + 1];
  return next
    ? { status: "IN_MANUFACTURE", stage: next }
    : { status: "READY_TO_SHIP", stage: null };
}

/**
 * One step backwards along the same chain, for the revert control:
 *
 *   Untriaged ← Design ← Casting ← Workshop ← Setting ← Polishing ← Plating
 *             ← Ready to ship
 *
 * Reverting out of Design clears the status entirely (back to untriaged),
 * which is why status is nullable: the row survives so its promised date and
 * movement history aren't lost by an undo.
 *
 * Returns null when there is nowhere further back to go.
 */
export function prevStep(
  column: BoardColumn
): { status: TrackStatus | null; stage: TrackStage | null } | null {
  if (column === UNTRIAGED) return null; // already at the start

  // Finished pieces step back to the last manufacturing stage.
  if (column === "READY_TO_SHIP") {
    return { status: "IN_MANUFACTURE", stage: STAGES[STAGES.length - 1] };
  }

  const i = STAGES.indexOf(column);
  const prev = STAGES[i - 1];
  return prev
    ? { status: "IN_MANUFACTURE", stage: prev }
    : { status: null, stage: null }; // out of Design → untriaged
}

/** Which column an item belongs in, given its stored state. */
export function columnFor(
  status: TrackStatus | null | undefined,
  stage: TrackStage | null | undefined
): BoardColumn {
  if (status === "READY_TO_SHIP") return "READY_TO_SHIP";
  if (status === "IN_MANUFACTURE" && stage) return stage;
  return UNTRIAGED;
}
