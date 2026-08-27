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
// A real calendar date, so the board can be filtered to a range.
//
// Stored as a plain "YYYY-MM-DD" string rather than a DateTime, deliberately:
// a date promised to a customer is a calendar DAY, not an instant. Held as a
// UTC timestamp it would render as the previous day for a workshop at
// UTC+5:30 — the same class of bug the order-date filter had to solve. The
// string form also compares and sorts correctly with plain <, and is exactly
// what <input type="date"> emits and expects.
//
// Free-form context ("before Diwali", "customer travelling") lives in the
// separate `note` field, so neither has to do the other's job.

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isPromisedDate(value: unknown): value is string {
  return typeof value === "string" && DATE_RE.test(value);
}

/** Valid "YYYY-MM-DD" or null. Anything else is discarded, not guessed at. */
export function cleanPromisedDate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return isPromisedDate(trimmed) ? trimmed : null;
}

/** "15 Sep" — compact enough for a card. */
export function formatPromisedDate(value: string | null): string | null {
  if (!isPromisedDate(value)) return null;
  const [y, m, d] = value.split("-").map(Number);
  // Built and read back in UTC so no local offset can shift the day.
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    timeZone: "UTC",
  });
}

/**
 * Is this date inside the (inclusive) range? Empty bounds mean "unbounded".
 * ISO dates compare correctly as strings, so no parsing is involved.
 */
export function withinDateRange(
  value: string | null,
  from: string,
  to: string
): boolean {
  if (!isPromisedDate(value)) return false; // no date can't match a range
  if (from && value < from) return false;
  if (to && value > to) return false;
  return true;
}

// ── Note ──────────────────────────────────────────────────────────────────
// Free text, exactly as typed. Capped only so a stray paste can't bloat a row.

export const NOTE_MAX = 200;

export function cleanNote(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().slice(0, NOTE_MAX);
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
