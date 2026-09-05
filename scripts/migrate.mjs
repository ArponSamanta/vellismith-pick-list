#!/usr/bin/env node
/**
 * `prisma migrate deploy`, with retries.
 *
 * ── Why this exists ───────────────────────────────────────────────────────
 * Neon's free plan suspends the compute after five minutes idle. The first
 * connection has to wake it, and Prisma Migrate opens by taking a Postgres
 * advisory lock with a fixed 10-second timeout. When a cold start plus the
 * connection handshake eats that budget, migrate aborts with:
 *
 *     Error: P1002 — The database server was reached but timed out.
 *     Context: Timed out trying to acquire a postgres advisory lock
 *
 * Nothing is wrong: the very next attempt succeeds in a few seconds, because
 * the failed one woke the compute. Prisma exposes no way to lengthen that
 * timeout, so the fix is simply to try again.
 *
 * It matters more on Render than in dev. There this runs from `docker-start`
 * before the server boots, so a cold database doesn't just print an error —
 * it fails the container start, and the deploy goes down.
 *
 * Retries are safe because `migrate deploy` is idempotent: it applies only
 * migrations absent from the _prisma_migrations table, and an attempt that
 * never acquired the lock changed nothing.
 */

import { spawn } from "node:child_process";

const ATTEMPTS = 3;
/** Grows so a database that is slow rather than asleep still gets a chance. */
const BACKOFF_MS = [3000, 7000];

function runMigrate() {
  return new Promise((resolve) => {
    const child = spawn("npx", ["prisma", "migrate", "deploy"], {
      stdio: "inherit",
      // Windows needs a shell to resolve `npx`; harmless elsewhere, and no
      // part of this command comes from user input.
      shell: true,
    });
    child.on("close", (code) => resolve(code ?? 1));
    child.on("error", () => resolve(1));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
  const code = await runMigrate();
  if (code === 0) process.exit(0);

  if (attempt < ATTEMPTS) {
    const wait = BACKOFF_MS[attempt - 1];
    console.warn(
      `\n[migrate] attempt ${attempt}/${ATTEMPTS} failed (exit ${code}). ` +
        `The database may still be waking up — retrying in ${wait / 1000}s.\n`
    );
    await sleep(wait);
  }
}

console.error(
  `\n[migrate] still failing after ${ATTEMPTS} attempts. This is no longer a ` +
    `cold start — check DATABASE_URL and that the Neon project is active.\n`
);
process.exit(1);
