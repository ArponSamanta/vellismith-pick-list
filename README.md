# Pick List Generator

A Shopify embedded admin app for a jewellery manufacturer. It turns the store's unfulfilled orders into an aggregated **pick list** — one line per product and variant with the exact quantity *still to be made* — then follows each piece through the workshop and groups pieces into production runs.

Three pages, one idea each:

| Page | Question it answers |
|---|---|
| **Pick List** | What needs making? |
| **Track** | Where is each piece right now? |
| **Batches** | Which tray is it travelling in? |

Built and maintained for [Vellismith](https://vellismith.com), a D2C handcrafted 925 silver brand.

---

## Stack

| | |
|---|---|
| Framework | React Router v7 (server `loader`/`action` routes) |
| Shopify | `shopify-app-react-router`, App Bridge React, Admin GraphQL API |
| Database | PostgreSQL (Neon) via Prisma |
| Build | Vite + Rollup |
| Hosting | Render (Node SSR server) |
| Language | TypeScript |

---

## What it does

### Pick List

Press **Generate Pick List**, optionally narrowed by date range, keyword and sort order. The app finds every order still owing the customer something, reads how many units of each variant remain outstanding, and aggregates across all orders — "12 orders want the Rose Pendant" becomes one line: *Rose Pendant · 12*.

Two A4 print layouts: a dense **Manufacturing** sheet (4 products per row) and a **Tracking** table (one row per product). Both are real `<table>` elements, so the sheet pastes into Google Docs or Word as an editable table.

Once generated, everything reshapes **client-side** — keyword search, a searchable multi-select variant drill-down with recalculated totals, sort, and column toggles. Generate is the only round trip.

### Track

A board following every ordered line through the bench:

```
Untriaged ──┬─→ Ready to ship          (pulled from stock)
            └─→ Design → Casting → Workshop → Setting → Polishing → Plating → Ready to ship
```

Cards in the Ready-to-ship column carry an **order-level** verdict: green when every outstanding line of that order is ready, red when the order still has lines elsewhere on the board. Green is the packing queue.

### Batches

A **run** is a tray of metal cast together and moving through the bench as one job. Runs are organised **by product, not by variant** — a gold-plated nose pin and a silver one are the same casting, diverging only at plating. What a piece becomes is deferred to the **split** stage, when the pieces are polished and the week's orders are known.

Four numbers govern a run:

- **Planned** — raw pieces to cast, deliberately not split by finish
- **Committed** — pieces owed to order lines the run has claimed, read live
- **Surplus** — `planned − committed`, floored at zero; becomes sellable stock
- **Shortfall** — what is owed and will not exist

A run may plan fewer pieces than it owes; the rest follows next week.

---

## Architecture

### The two-phase fetch

Shopify prices every query by cost against a ~1000-point leaky bucket. Fetching full fulfilment detail for every order in one shot blows the budget and gets throttled. So the sweep runs in two deliberate phases:

```
Phase 1 (cheap)     fetchOrderIds
                    ├─ query fulfillment_status:unfulfilled + :partial, concurrently
                    └─ ask for ids + dates only, 250/page, paginate to the end
                              ↓  collect & de-duplicate
Phase 2 (detailed)  fetchFulfillmentData
                    └─ alias-batch the heavy query for those ids:
                       fulfillment orders → line items → remainingQuantity, variant, product, image
                              ↓  fold into a product → variant map
Assemble            sortPickList + keyword filter
```

The classic "list cheaply, then hydrate."

### remainingQuantity is the keystone

Each fulfilment-order line item exposes `remainingQuantity` — units not yet fulfilled. One field handles every awkward case silently: fully shipped → `0`, removed by an order edit → `0`, refunded → `0`, partially shipped → the exact remainder. Skip anything `<= 0`, trust the rest.

### Who owns what

> **Shopify owns *what*. Postgres owns *where*.**

Each board load starts from live unfulfilled order lines and left-joins stored status onto them. Three things fall out for free:

- a shipped line **disappears by itself** — no cleanup job, no archive flag
- an untriaged line **needs no database row at all** — absence *is* the untriaged state
- titles, quantities and images always come from Shopify, never from a local copy

### Caching boundary

The Shopify line sweep is cached in Postgres, one row per shop, 15-minute TTL, with a Refresh button that forces a real read. **Tracking status is never cached** — it is read from `TrackedItem` on every load, so a stage change made on the workshop floor appears immediately.

That boundary confines staleness to one sentence: *an order placed in the last few minutes may not be listed yet.* The board states its own age ("Orders 6 min ago") beside Refresh, and a failed refresh serves the stale copy rather than an error.

### Timezone handling

The merchant is in IST (UTC+5:30). The date picker yields a plain calendar date; Shopify stores UTC. `localDateToUTCString` converts a local day to its true UTC boundaries:

```
"2026-05-05" as an IST day →
  start (inclusive) = 2026-05-04T18:30:00Z   // May 5 00:00 IST
  end   (exclusive) = 2026-05-05T18:30:00Z   // May 6 00:00 IST
```

Enforced twice: the API query carries the range, and an in-memory `isWithinDateRange` backstop re-checks each order on **epoch milliseconds** via `Date.parse`, so a `...Z` vs `+05:30` format difference can't cause edge leakage.

---

## Data model

```prisma
model TrackedItem {
  id           String  @id @default(cuid())
  shop         String
  lineItemId   String   // the real identity — Shopify line-item GID
  status       String?  // null = untriaged
  stage        String?
  promisedDate String?
  // … snapshot of title / variant / qty / image
  @@unique([shop, lineItemId])
}
```

The primary key is a generated `cuid`, used only so `TrackedItemEvent` has something stable to hang off. The key every query uses is the **natural key** `[shop, lineItemId]`. `shop` comes from the authenticated session and never from a form — that is what stops a forged request reaching another store's row.

`TrackedItemEvent` is append-only: one row per movement, written in the same transaction as the change, so a status can never exist without its history.

---

## Getting started

> Verify the script names and env keys against your own `package.json` and `.env.example` — the commands below follow the Shopify react-router template defaults.

```bash
npm install
cp .env.example .env        # fill in the values below
npx prisma migrate deploy
npm run dev                 # or: shopify app dev
```

### Environment

| Variable | Purpose |
|---|---|
| `SHOPIFY_API_KEY` | From the Partner Dashboard |
| `SHOPIFY_API_SECRET` | From the Partner Dashboard |
| `SHOPIFY_APP_URL` | Public tunnel or deployed URL |
| `SCOPES` | See **Access scopes** below |
| `DATABASE_URL` | Postgres connection string |

### Access scopes

The app needs `read_orders`, `read_products`, `read_inventory` and `write_inventory`, plus the protected **`read_all_orders`**.

Without `read_all_orders`, Shopify only exposes the **last 60 days** of orders to an app. Older orders are *invisible to the API entirely* — not mis-dated, not filtered out, simply absent — while the Admin UI lists them normally. See [The 60-day wall](#the-60-day-wall).

Granting it is a three-step process, and editing config alone does nothing:

1. Request the scope and get Shopify's approval
2. Add it to `shopify.app.toml`
3. **Run `shopify app deploy`**, then re-authorize the app

Step 3 is the one that actually matters. Editing `shopify.app.toml` or `SCOPES` only *requests* a scope; nothing is granted until Shopify approves and a fresh token is minted. The app logs `read_all_orders granted: true|false` on each sweep — that line is the fast check if the wall ever resurfaces on another store.

### Deployment notes

- Render's free tier spins a service down after ~15 minutes idle; the next visitor waits ~50 s. A `/health` resource route (outside the `app.*` tree, since `authenticate.admin()` would reject an anonymous caller) is pinged every 10 minutes by cron-job.org.
- **The health check deliberately touches nothing.** Neon's free plan allows 100 CU-hours a month and suspends compute after 5 minutes idle. A database query every 10 minutes would keep it awake permanently — ~730 hours against a 100-hour allowance, exhausting the quota in about four days. The ping returns JSON and does no work; a database probe exists behind a token for manual use. Responses are `no-store`.
- Prisma must not point at a SQLite file. It did once, inside the container, and every deploy wiped it — unnoticed only because sessions silently re-create themselves. Workshop progress would not have been so forgiving.

### Tuning constants

| Constant | Value | Notes |
|---|---|---|
| `ORDERS_PER_BATCH` | `10` | 10 × 43 points = 430/batch, 2 concurrent = 860 of 1000 |
| `ITEMS_PER_FO` | `20` | **Do not lower.** A fulfilment order carrying more line items than requested is *silently truncated* |
| `STORE_TZ_OFFSET_MINUTES` | `330` | IST |

---

## Notable engineering decisions

### Measure before optimising

Opening the board took **35 seconds** and nobody wanted to use it. The first instinct was Shopify's rate limiter. One log line settled it:

```
[tracker] 740 orders → 996 open lines · ids 1240ms · detail 33915ms (37 rounds) · total 35155ms
```

Phase 1 was **1.2 s, about 3%** of the time. Everything else was 37 sequential round trips at ~900 ms each — the estimate before measuring had been 500 ms, so tuning against the guess would have aimed at the wrong number. And less than half the query budget was in use: the bottleneck was the *number* of requests, not permission to make them.

Doubling the batch size took 70 s → 35 s. More was available — halving `ITEMS_PER_FO` would have allowed four batches in flight, roughly 17 s — and was **rejected**, because silent truncation of a wholesale order is a far worse outcome than a slow page.

35 s was the wrong *shape* of problem for tuning. The sweep discovers which order lines are outstanding, a fact that changes a handful of times a day; re-deriving it on every page open was not slow work so much as **repeated work**. Caching it was the real fix.

### The 60-day wall

One complaint — "the date filter is wrong" — was four separate problems stacked, each revealed as the one above it was fixed:

1. **The bundler deleted the date filter.** The module was loaded via `await import()`; across that boundary Rollup couldn't see the call site that passes dates, another caller passed none, so it "proved" the option always `undefined` and dead-code-eliminated the whole filter. Found by reading the compiled `build/server/index.js` and finding `isWithinDateRange` collapsed to `return true`. Fixed with a static import.
2. **Throttling silently dropped orders.** Three concurrent batches at ~940 points demanded ~2820 against a 1000 bucket with no retry; throttled batches were caught, skipped, and their quantities simply lost. Fixed with `graphqlWithRetry` honouring `throttleStatus`, plus retuned batch cost.
3. **Shopify's 60-day order-history wall.** With the query provably correct, ranges from May 22 onward worked and May 21 and earlier returned zero — while the Admin listed unfulfilled orders in exactly that range. Today was July 21. May 22 → July 21 is exactly 60 days.

**The lesson worth the whole saga:** when the API returns nothing but the Admin UI clearly shows the data, suspect a scope limit before a query bug — the two systems don't share access rules. The fix may live entirely outside your code. Here it was an approval and a deploy, not a line changed.

Two reasonable theories were disproven along the way rather than argued away: `unshipped` → `unfulfilled + partial` (not the cause, but a genuine correctness improvement, so it stayed) and `created_at` → `processed_at` (a no-op on this store — a diagnostic showed the two fields identical).

### Anything slow in a loader is not a slow page

Clicking **Track** appeared to do nothing. A screenshot was the tell: the address bar already read `/app/track` while the body still showed the previous page. React Router keeps the current route on screen until the next route's loader resolves, and the Track loader ran the full sweep first — 10–20 seconds of looking dead.

Moving the fetch out of the blocking loader into a resource route the page requests *after* it renders, behind skeleton columns, made the page appear instantly.

Two follow-ons: React Router revalidates loaders after an action completes, so every status tap was quietly re-fetching every order (fixed with `shouldRevalidate` on the data route); and `board.data?.lines ?? []` returns a brand-new array every render while loading, which as an effect dependency is an infinite loop — caught as an **ESLint warning**, not an error, with typecheck, lint and build all passing.

### Invariants need their own function

Finish quantities must total exactly the planned quantity, because the inventory write posts `finish.quantity` to Shopify. When a run planned fewer pieces than it owed, seeding clamped its surplus at zero and handed every finish its full demand — so the finishes summed to *committed*, not to what the run makes. Plan two against five orders and **five pieces would have been posted to Shopify, three of which did not exist**.

It never fired because four quantity floors silently raised the planned quantity to the committed total. Removing a cosmetic annoyance would have made it live. *Ask what a "harmless" guard is load-bearing for before removing it.*

Separately, two code paths claim an order line — the per-product "Add to run" button and the surplus banner's "Allocate all" — and the covering re-seed lived inline in the first one only. Extracted to one shared `recoverAllocation` that both call. *When two entry points must maintain the same invariant, the invariant needs its own function.*

### The one write to Shopify

Everything else this app does is read-only. When a run is marked `MADE`, its pieces are added to inventory — once, guarded by claiming an `inventorySyncedAt` stamp *before* calling Shopify and releasing it if the call fails, so a double-tap cannot post twice.

Two non-obvious things about that write:

- **The delta is the whole run, not the surplus.** Shopify has already done that subtraction: a tracked variant with seven unfulfilled orders holds `on_hand 0 · committed 7 · available −7`. Adding twenty gives `on_hand 20 · committed 7 · available 13` — the surplus, exactly. Adding only thirteen would leave the workshop physically holding pieces Shopify had never counted.
- **It adjusts `available`, never `on_hand`.** `on_hand` is not a writable ledger state — it is the derived sum of available, committed, reserved, damaged, quality_control and safety_stock, and the API rejects it outright. Adjusting `available` by the same delta reaches the identical end state, and is the one name that does not require a per-change `ledgerDocumentUri`.

### Derive the label from the state

`doneAtSplit` means "nothing left at or after the split stage" — nothing more. For a silver finish that skips plating, that is true from the moment the run is created, while casting, workshop, setting and polishing are all still ahead of it. The finishes list therefore announced a piece was finished on a run that had barely started.

"Finished" now comes from `variantPosition`, the same function that decides which board column the pieces are in, so the sentence cannot disagree with where they actually are. *Two derived facts about one thing will drift.*

### Per-variant routes

Silver is never plated. A plain band is never set. Each variant carries a remembered `skipStages` route, and the run derives each variant's position from its own:

```ts
// what is the next stage this variant still needs,
// from where the run has got to?
const at = STAGES.indexOf(batchStage);
const next = requiredStages(skip).find(s => STAGES.indexOf(s) >= at);
return next ?? "READY_TO_SHIP";
```

One question replaced four hand-written cases. Previously a band that skips Setting sat in the Workshop column while the run did setting — reading as "queued for workshop" long after workshop had finished with it, and indistinguishable from a piece genuinely stuck.

### Scope limits commitments, not capability

A run can be narrowed to particular variants. **Scope limits which order lines the run takes on; it does not limit what the pieces can become.** The casting is shared, so a clip-on run casts metal that could physically become anything — it simply should not be handed the pierced orders.

Without this, a run meant for clip-ons claimed every outstanding line for the product and locked the pierced orders into a run that was never going to make them. The lock-out, not the miscount, was the damage.

The distinction does break down at the split: a piece already carrying a screw post cannot be plated into a clip-on. The split dialog offers the scoped set plus anything that already holds pieces.

---

## Known limits

- **Printing inside the Shopify native mobile app doesn't work.** The WebView blocks both `window.print()` and opening a new document — there is no web print API at all. No code can fix it; the app detects the failure and shows a toast telling the user to open the store in a desktop or phone *browser*.
- **First load of the day pays the full 35 s sweep.** Every load after is a single Postgres read. The next step, if that first load ever matters enough, is keeping the cache warm from `orders/create` and `orders/fulfilled` webhooks — deliberately deferred until the simpler fix has been shown to fall short.
- **Lines vs pieces.** The pick list counts *pieces* (the sum of every `remainingQuantity`); the board counts *order lines*. One line for three rings is 3 and 1 respectively. Both figures are labelled `lines/pieces` rather than reconciled, because two correct measures that disagree are worse than one unless you label both.
- **No automated test suite.** Several classes of bug here — bundler artifacts, framework revalidation behaviour, render loops — only ever surface in a browser. A green build says the types agree, nothing more.

---

## Project structure

```
app/
  routes/
    app._index.tsx          Pick list page
    app.track.tsx           Tracker board
    app.track.board.tsx     Board data (resource route)
    app.batch.tsx           Production runs
    health.ts               Uptime ping, outside app.*
  picklist.server.ts        Two-phase sweep, aggregation, date handling
  tracker.server.ts         Board assembly, cache, sweep deduplication
  batch.server.ts           Runs, allocation, split
  inventory.server.ts       The one write to Shopify
  batching.ts               variantPosition, stage routes
prisma/
  schema.prisma
shopify.app.toml            Scopes live here — deploy after editing
```

---

## Debugging method

The specific bugs are stories; the method is the transferable part.

1. **Reproduce from the logs.** The real query string and the kept/returned counts pin each layer to a stage.
2. **Rule out cheaply, and let evidence overrule you.** Quotes, timezone, caches, minification, status value, date field — each falsified with one quick test, several of them my own theories.
3. **Distrust the source; read the artifact.** When behaviour and code disagree, the compiled build is the truth.
4. **When the API and the UI disagree, suspect permissions.** An empty API result beside a populated Admin screen is a scope smell, not a query smell.
5. **Get ground truth with a throwaway probe.** Dumping the missing orders' fields — and seeing nothing return — turned a theory into a fact.
6. **Do the arithmetic.** "Works from the 22nd, today is the 21st" → 60 days. The boundary named the cause.
7. **Read the URL before blaming the link.**
8. **Treat lint warnings as findings.** A dependency that "could change on every render" was an infinite loop wearing a yellow squiggle.
9. **Measure before optimising, then again after.**

