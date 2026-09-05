/**
 * Shared vocabulary for manufacturing batches.
 *
 * Imported by BOTH server and client, so it must stay free of any node-only
 * dependency — same rule as tracking.ts, which this deliberately builds on
 * rather than duplicating: a batch's stage IS a TrackStage, so that a run and
 * the individual pieces inside it can never drift into different vocabularies.
 */

import {
  STAGES,
  UNTRIAGED,
  columnFor,
  type BoardColumn,
  type TrackStage,
} from "./tracking";

// ── Status ────────────────────────────────────────────────────────────────
// OPEN → MADE → CLOSED is the happy path; CANCELLED is the exit before any
// metal exists. The distinction that matters is MADE: before it a batch is a
// plan and everything is editable, after it the pieces physically exist and
// the arithmetic is frozen.

export const BATCH_STATUSES = ["OPEN", "MADE", "CLOSED", "CANCELLED"] as const;
export type BatchStatus = (typeof BATCH_STATUSES)[number];

export const BATCH_STATUS_LABELS: Record<BatchStatus, string> = {
  OPEN: "In production",
  MADE: "Made",
  CLOSED: "Archived",
  CANCELLED: "Cancelled",
};

export function isBatchStatus(value: unknown): value is BatchStatus {
  return (
    typeof value === "string" && (BATCH_STATUSES as readonly string[]).includes(value)
  );
}

/**
 * Runs that still hold their order lines.
 *
 * Lives here rather than in batch.server so the TRACKER can use it too — the
 * board labels each card with the run carrying it, and tracker.server must not
 * import batch.server, which already imports tracker.server for getBoard and
 * setStatus. A shared constant in this pure module breaks the cycle.
 */
export const LIVE_BATCH_STATUSES = ["OPEN", "MADE"] as const;

/** A batch still being planned or built — the only state that accepts edits. */
export function isEditable(status: BatchStatus): boolean {
  return status === "OPEN";
}

// ── Quantities ────────────────────────────────────────────────────────────

/**
 * Upper bound on a single run, purely as a typo guard: a stray keypress
 * turning 20 into 2000 would otherwise write 2000 pieces into real inventory.
 * Nothing about the workshop needs a number this large.
 */
export const PLANNED_MAX = 10_000;

/**
 * The part of a run that becomes sellable stock.
 *
 * Never negative: a batch whose orders have grown past its planned quantity
 * is under-planned, not negatively stocked. The UI flags that case separately
 * rather than showing a minus sign here.
 */
export function surplusOf(planned: number, committed: number): number {
  return Math.max(0, planned - committed);
}

/** True when orders now outnumber what the run will make. */
export function isUnderPlanned(planned: number, committed: number): boolean {
  return committed > planned;
}

/**
 * A planned quantity that is safe to store: a whole number, at least the
 * committed total, and below the typo ceiling. Returns null when the input
 * can't be read as a number at all, so the caller can reject rather than
 * silently substituting a value nobody chose.
 */
export function cleanPlannedQuantity(
  value: unknown,
  committed: number
): number | null {
  const n =
    typeof value === "number" ? value : Number(String(value ?? "").trim());
  if (!Number.isFinite(n)) return null;
  const whole = Math.floor(n);
  if (whole < 0) return null;
  return Math.min(PLANNED_MAX, Math.max(committed, whole));
}

// ── Stage spread ──────────────────────────────────────────────────────────

/**
 * Where a batch's member lines actually sit right now.
 *
 * A batch carries one stage, but its lines can diverge — someone sends a
 * single cracked ring back to Casting while the rest move on. Rather than
 * forcing them back into line, the board reports the spread and advancing
 * only touches the lines that are actually at the batch's stage.
 */
export function stageSpread(
  lines: Array<{ status: string | null; stage: string | null }>
): Map<BoardColumn, number> {
  const spread = new Map<BoardColumn, number>();
  for (const line of lines) {
    const col = columnFor(
      line.status as never,
      line.stage as never
    );
    spread.set(col, (spread.get(col) ?? 0) + 1);
  }
  return spread;
}

/** True when every member line sits exactly where the batch says it does. */
export function isInStep(
  spread: Map<BoardColumn, number>,
  stage: TrackStage | null
): boolean {
  const expected: BoardColumn = stage ?? UNTRIAGED;
  for (const [col, n] of spread) {
    if (col !== expected && n > 0) return false;
  }
  return true;
}

// ── Stage paths ───────────────────────────────────────────────────────────
// Not every piece passes through every stage: a silver piece is never plated,
// a plain band is never set. Each variant therefore walks its own subset of
// the run's stages, and finishes as soon as its last required one is done —
// while the run carries on with the rest.

/** The stages this variant actually passes through, in workshop order. */
export function requiredStages(skip: readonly string[]): TrackStage[] {
  return STAGES.filter((s) => !skip.includes(s));
}

/** The union of stages any variant in a run still needs. */
export function neededStages(
  variants: ReadonlyArray<{ skipStages: readonly string[] }>
): Set<TrackStage> {
  const needed = new Set<TrackStage>();
  for (const v of variants) {
    for (const s of requiredStages(v.skipStages)) needed.add(s);
  }
  return needed;
}

/**
 * Where a variant's pieces sit, given where the RUN is.
 *
 * The run has one position; each variant derives its own from it. Four cases,
 * and they are the whole of the skipped-stage behaviour:
 *
 *   • the run is at a stage this variant needs → the pieces are at that stage
 *   • the run hasn't reached this variant's first stage yet → untriaged
 *   • the run is past a stage this variant skips but it has more to come →
 *     the pieces WAIT at the last stage they actually had
 *   • nothing required remains → finished and ready to ship, even though the
 *     run itself is still going
 */
export function variantPosition(
  batchStage: TrackStage | null,
  status: BatchStatus,
  skip: readonly string[]
): BoardColumn {
  if (status === "MADE" || status === "CLOSED") return "READY_TO_SHIP";
  if (!batchStage) return UNTRIAGED;

  const required = requiredStages(skip);
  // A variant needing no stages at all is finished the moment the run starts:
  // it is assembled from parts already on hand, or bought in.
  if (required.length === 0) return "READY_TO_SHIP";

  const at = STAGES.indexOf(batchStage);
  const done = required.filter((s) => STAGES.indexOf(s) <= at);
  if (done.length === 0) return UNTRIAGED; // its first stage is still ahead

  const last = done[done.length - 1];
  if (last === batchStage) return batchStage; // being worked right now

  // Between stages: waiting for its next one, or finished if it has none.
  const more = required.some((s) => STAGES.indexOf(s) > at);
  return more ? last : "READY_TO_SHIP";
}

/**
 * What "advance this batch" means.
 *
 * A run with no stage is starting production, so it enters at the first stage
 * anything needs. Stages NOTHING in the run requires are skipped outright — a
 * run of only silver pieces never stops at Plating. Running out of stages
 * completes the run: it becomes MADE, which is what unlocks the stock write,
 * because the pieces only exist once the run is finished.
 */
export function nextBatchStep(
  stage: TrackStage | null,
  needed?: ReadonlySet<TrackStage>
): { stage: TrackStage | null; status: BatchStatus } {
  const at = stage ? STAGES.indexOf(stage) : -1;
  const next = STAGES.slice(at + 1).find((s) => !needed || needed.has(s));
  return next ? { stage: next, status: "OPEN" } : { stage: null, status: "MADE" };
}

/** One step back. Returns null at the very start, where there is nowhere to go. */
export function prevBatchStep(
  stage: TrackStage | null,
  status: BatchStatus,
  needed?: ReadonlySet<TrackStage>
): { stage: TrackStage | null; status: BatchStatus } | null {
  const wanted = (s: TrackStage) => !needed || needed.has(s);

  // Un-finishing a run puts it back at the last stage it actually stopped at.
  if (status === "MADE") {
    const last = [...STAGES].reverse().find(wanted);
    return last ? { stage: last, status: "OPEN" } : null;
  }
  if (!stage) return null;

  const before = STAGES.slice(0, STAGES.indexOf(stage)).filter(wanted);
  return { stage: before[before.length - 1] ?? null, status: "OPEN" };
}

// ── Scrap ─────────────────────────────────────────────────────────────────
// What a run intended to make and what survives are different numbers, and
// only the survivors may be sold.

/** Pieces that actually exist: what was planned, less what broke. */
export function madeQuantity(planned: number, scrapped: number): number {
  return Math.max(0, planned - scrapped);
}

/**
 * Pieces owed to customers that no longer exist to give them.
 *
 * Breakage eats the surplus first — that is what a surplus is for. Only once
 * it is gone does scrap become a shortfall somebody has to act on.
 */
export function shortfallOf(
  planned: number,
  scrapped: number,
  committed: number
): number {
  return Math.max(0, committed - madeQuantity(planned, scrapped));
}

export const SCRAP_NOTE_MAX = 200;

// ── Name ──────────────────────────────────────────────────────────────────
// A run holds many different variants, so it can't be identified by what it
// makes the way a single-variant batch could. It needs a name of its own —
// "Run 07", "Diwali restock" — which is what the workshop will actually call
// it out loud.
//
// The default is a running number rather than a timestamp. A date-and-time
// name is unambiguous but unsayable: nobody calls across a workshop for "the
// run from the fifth at half six". A number is short enough to write on a tray
// tag, read back over the phone, and say out loud — which is the whole job of
// this string.

export const BATCH_NAME_MAX = 80;

/** The shape of an auto-named run. Anything else is a name somebody chose. */
const RUN_NAME_PATTERN = /^run[\s.·-]*0*(\d+)$/i;

/**
 * Two digits, so the list sorts and scans as a column.
 *
 * Padding stops at the point it stops helping: past 99 the number simply grows
 * ("Run 100"), because widening every earlier name to three digits to keep
 * them aligned would rename runs that are already written on trays.
 */
export function runName(sequence: number): string {
  return `Run ${String(Math.max(1, Math.floor(sequence))).padStart(2, "0")}`;
}

/** The number in an auto-named run, or null for a name somebody chose. */
export function runSequence(name: string): number | null {
  const match = RUN_NAME_PATTERN.exec(name.trim());
  if (!match) return null;
  const n = Number(match[1]);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/**
 * The next number to hand out, from the names already used.
 *
 * Highest-so-far plus one, NOT a count of runs. Counting would re-issue a
 * number the moment a run is renamed or deleted, and two different trays
 * called "Run 04" — one of them in the archive, one on the bench — is exactly
 * the confusion a number is supposed to prevent. Cancelled runs are counted
 * too, for the same reason: they existed, they were called something, and that
 * name should stay spent.
 *
 * A manually chosen name is invisible to this: "Diwali restock" holds no
 * number, so it neither advances nor blocks the sequence.
 */
export function nextRunSequence(names: Iterable<string>): number {
  let highest = 0;
  for (const name of names) {
    const n = runSequence(name);
    if (n !== null && n > highest) highest = n;
  }
  return highest + 1;
}

/**
 * Never empty: an unnamed run would be unidentifiable in the list.
 *
 * The fallback is passed in rather than generated here, because the two
 * callers want different ones. Creating a run with the field blank should take
 * the next number; renaming one to blank should keep the name it already has,
 * since clearing a text box is not a request to be renumbered.
 */
export function cleanBatchName(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim().slice(0, BATCH_NAME_MAX);
  return trimmed === "" ? fallback : trimmed;
}

// ── Note ──────────────────────────────────────────────────────────────────

export const BATCH_NOTE_MAX = 300;

export function cleanBatchNote(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().slice(0, BATCH_NOTE_MAX);
  return trimmed === "" ? null : trimmed;
}
