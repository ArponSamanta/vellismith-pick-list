/**
 * Manufacturing batches.
 *
 * Two halves: the runs currently in production, and the outstanding work not
 * yet in a run. A run is a production decision — "cast these twelve designs
 * together" — so unlike the tracker board it isn't derived from Shopify and
 * doesn't disappear when orders ship. What it DISPLAYS is joined live on every
 * read, so a cancelled order drops out of the arithmetic on its own.
 *
 * Deliberately no optimistic UI, unlike the Track board. There the unit of
 * work is one tap moving one card, and instant feedback is what makes the page
 * usable on a phone. Here a single tap advances a whole run, adjusts dozens of
 * order lines and can write real stock to Shopify — showing a result before
 * the server confirms it would be showing something that might not be true.
 * Reloads are cheap because the underlying order list is cached.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useFetcher } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";

import { authenticate } from "../shopify.server";
import type { loader as dataLoader } from "./app.batch.data";
import type { loader as inventoryLoader } from "./app.batch.inventory";
import type { loader as productsLoader } from "./app.batch.products";
import {
  BatchError,
  addProductsToBatch,
  addUnclaimedLines,
  advanceBatch,
  archiveBatch,
  autoAllocate,
  cancelBatch,
  createBatchFromSelection,
  pullBatchToStage,
  recordScrap,
  removeLineFromBatch,
  removeProductFromBatch,
  removeScrap,
  revertBatch,
  setVariantRoute,
  splitFinishes,
  updateBatch,
  updateBatchProduct,
  type BatchCandidate,
  type BatchProductView,
  type BatchView,
  type ProductSelection,
} from "../utils/batch.server";
import { writeBatchStock } from "../utils/inventory.server";
import {
  BATCH_NAME_MAX,
  BATCH_NOTE_MAX,
  BATCH_STATUS_LABELS,
  SCRAP_NOTE_MAX,
  nextBatchStep,
  prevBatchStep,
  surplusOf,
} from "../utils/batching";
import {
  COLUMN_LABELS,
  STAGES,
  STAGE_LABELS,
  formatPromisedDate,
  isStage,
  type TrackStage,
} from "../utils/tracking";

const DATA_ROUTE = "/app/batch/data";
const INVENTORY_ROUTE = "/app/batch/inventory";
const PRODUCTS_ROUTE = "/app/batch/products";

/** Typing pause before the catalogue search fires, so it isn't per keystroke. */
const SEARCH_DEBOUNCE_MS = 300;

/**
 * Image width requested for the printed sheet.
 *
 * Same reasoning as the pick list: the browser rasterises every image when it
 * builds the PDF, so full-size originals make an enormous file — while the
 * bench genuinely needs to tell one fine-jewellery design from another at a
 * glance. A sized-down copy is sharp on paper and a fraction of the bytes.
 */
const PRINT_IMG_WIDTH = 480;

/** Minimal tokens for the standalone print document — it has no app stylesheet. */
const PRINT_DOC_TOKENS = `
  @import url('https://fonts.googleapis.com/css2?family=Archivo:wght@400;600;800&display=swap');
  :root { --font-heading: "Archivo", system-ui, sans-serif; --font-body: "Archivo", system-ui, sans-serif; }
`;

/**
 * Styles for the printable run sheet.
 *
 * Kept as one constant used by BOTH the hidden on-page section and the
 * standalone document opened in a new tab, so the two can never drift — the
 * same trick the pick list uses.
 */
const BATCH_PRINT_CSS = `
  #batch-print { font-family: var(--font-body); color: #201e1d; }
  #batch-print * { box-sizing: border-box; }

  /* Heading: the run's name and where it is. Nothing else — this sheet is an
     instruction to the bench, not a report. */
  .bp-head {
    border-bottom: 1.5pt solid #201e1d; padding-bottom: 3mm; margin-bottom: 4mm;
    display: flex; align-items: baseline; justify-content: space-between; gap: 6mm;
  }
  #batch-print h1 {
    font-family: var(--font-heading); font-weight: 800; font-size: 16pt;
    letter-spacing: -.01em; margin: 0;
  }
  .bp-stage {
    font-family: var(--font-heading); font-weight: 800; font-size: 11pt;
    letter-spacing: .1em; text-transform: uppercase; color: #ec3013;
    white-space: nowrap;
  }

  /* The card grid, deliberately identical to the pick list's manufacturing
     sheet: same four-up layout, same image-led card, same big quantity at the
     foot. The bench already reads that sheet; a run sheet in a different shape
     would be a second format to learn for no reason. */
  table.bpm { width:100%; border-collapse:collapse; table-layout:fixed; }
  .bpm tr { page-break-inside:avoid; break-inside:avoid; }
  .bpm td { width:25%; vertical-align:top; padding:2.5mm; border:1px solid #c9c7c6; }
  .bpm td:empty { border:none; }
  .bpc { border:none; overflow:hidden; }
  .bpc img { width:100%; height:auto; display:block; }
  .bpc-noimg {
    width:100%; height:22mm; background:#eae9e9; display:flex; align-items:center;
    justify-content:center; font-size:6pt; letter-spacing:.06em;
    text-transform:uppercase; color:#9b9797;
  }
  .bpc-body { padding:2mm 0 0; }
  .bpc-title {
    font-family:var(--font-heading); font-weight:800; font-size:8pt;
    line-height:1.2; margin-bottom:1.5mm; color:#201e1d;
  }
  .bpc-vars { font-size:6.5pt; color:#7d7979; line-height:1.45; margin-bottom:2mm; }
  .bpc-var-row { margin-bottom:.5mm; }
  .bpc-vars b { color:#201e1d; }
  .bpc-qty {
    display:flex; align-items:baseline; justify-content:space-between; gap:2mm;
    border-top:1.5px solid #201e1d; padding-top:1.5mm;
    font-family:var(--font-heading); font-weight:800; font-size:13pt; color:#ec3013;
  }
  .bpc-qty::before {
    content:"To make"; font-size:5.5pt; letter-spacing:.1em;
    text-transform:uppercase; color:#7d7979;
  }
`;

/** Per-product quantity fields are namespaced so one form can carry many. */
const QTY_PREFIX = "qty:";
/** Per-finish allocation fields in the plating handler. */
const FINISH_PREFIX = "finish:";

// ─── Server ───────────────────────────────────────────────────────────────

/** Trivial by design — see app.track.tsx for why the data lives elsewhere. */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return null;
};

/** Reads the repeated productId fields plus their matching qty:<id> field. */
function readSelections(form: FormData): ProductSelection[] {
  return form.getAll("productId").map((raw) => {
    const productId = String(raw);
    return { productId, plannedQuantity: form.get(`${QTY_PREFIX}${productId}`) };
  });
}

/**
 * Reads the plating handler's allocation: one `finish:<variantId>` field per
 * finish. Sent as a whole rather than per row, because the split is only
 * meaningful as a set that adds up.
 */
function readAllocation(form: FormData): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of form.entries()) {
    if (key.startsWith(FINISH_PREFIX)) {
      out[key.slice(FINISH_PREFIX.length)] = String(value);
    }
  }
  return out;
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;
  const form = await request.formData();

  const intent = String(form.get("intent") ?? "");
  const batchId = String(form.get("batchId") ?? "");
  const batchProductId = String(form.get("batchProductId") ?? "");
  // Offline tokens carry no user, so this is usually null. See tracker.server.
  const by = session.onlineAccessInfo?.associated_user?.email ?? null;

  try {
    switch (intent) {
      case "create": {
        const id = await createBatchFromSelection({
          admin,
          shop,
          name: form.get("name"),
          note: form.get("note"),
          products: readSelections(form),
        });
        return { ok: true, error: null, createdId: id, stock: null };
      }

      case "add-products":
        await addProductsToBatch({
          admin,
          shop,
          batchId,
          products: readSelections(form),
          by,
        });
        break;

      case "rename":
        await updateBatch({ shop, batchId, name: form.get("name") });
        break;

      case "note":
        await updateBatch({ shop, batchId, note: form.get("note") });
        break;

      case "product-qty":
        await updateBatchProduct({
          admin,
          shop,
          batchId,
          batchProductId,
          plannedQuantity: form.get("plannedQuantity"),
        });
        break;

      case "remove-product":
        await removeProductFromBatch({ admin, shop, batchId, batchProductId });
        break;

      // The plating handler: how many pieces carry each finish.
      case "split":
        await splitFinishes({
          admin,
          shop,
          batchId,
          batchProductId,
          allocation: readAllocation(form),
        });
        break;

      // A variant's permanent path, remembered for every future run.
      case "route":
        await setVariantRoute({
          shop,
          productId: String(form.get("productId") ?? ""),
          variantId: String(form.get("variantId") ?? ""),
          skipStages: form.getAll("skipStage").map(String),
        });
        break;

      case "scrap":
        await recordScrap({
          shop,
          batchId,
          batchProductId,
          quantity: form.get("quantity"),
          note: form.get("note"),
        });
        break;

      case "unscrap":
        await removeScrap({
          shop,
          batchId,
          scrapId: String(form.get("scrapId") ?? ""),
        });
        break;

      case "add-lines":
        await addUnclaimedLines({ admin, shop, batchId, batchProductId, by });
        break;

      case "auto-allocate": {
        const n = await autoAllocate({ admin, shop, by });
        return {
          ok: true,
          error: null,
          createdId: null,
          stock:
            n === 0
              ? "Nothing left to allocate — those pieces have been claimed since."
              : `${n} order ${n === 1 ? "line" : "lines"} filled from surplus.`,
        };
      }

      case "remove-line":
        await removeLineFromBatch({
          admin,
          shop,
          batchId,
          lineItemId: String(form.get("lineItemId") ?? ""),
        });
        break;

      case "advance":
        await advanceBatch({ admin, shop, batchId, by });
        break;

      case "revert":
        await revertBatch({ admin, shop, batchId, by });
        break;

      case "pull":
        await pullBatchToStage({ admin, shop, batchId, by });
        break;

      case "archive":
        await archiveBatch(shop, batchId);
        break;

      case "cancel":
        await cancelBatch({ admin, shop, batchId, by });
        break;

      case "stock": {
        const result = await writeBatchStock({
          admin,
          shop,
          batchId,
          locationId: String(form.get("locationId") ?? ""),
        });
        // Say what was skipped as well as what landed — a silent partial write
        // is how real pieces go missing from a stock count.
        const skipped =
          result.skipped.length > 0
            ? ` Skipped: ${result.skipped.map((s) => s.reason).join("; ")}.`
            : "";
        return {
          ok: true,
          error: null,
          createdId: null,
          stock:
            `Added ${result.totalDelta} pieces across ${result.written.length} ` +
            `variant(s) at ${result.locationName}.${skipped}`,
        };
      }

      default:
        return { ok: false, error: "Unknown action.", createdId: null, stock: null };
    }

    return { ok: true, error: null, createdId: null, stock: null };
  } catch (error) {
    // BatchError messages are written for the merchant; anything else is a bug
    // or an outage and gets a generic line plus a log entry.
    if (error instanceof BatchError) {
      return { ok: false, error: error.message, createdId: null, stock: null };
    }
    console.error("[batch] action error:", error);
    return {
      ok: false,
      error: "Couldn't save that change. Please try again.",
      createdId: null,
      stock: null,
    };
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

const IconRefresh = ({ size = 15 }: { size?: number }) => (
  <svg {...iconAttrs(size)}>
    <path d="M3 12a9 9 0 0 1 9-9 9 9 0 0 1 6.7 3H21" />
    <path d="M21 3v6h-6" />
    <path d="M21 12a9 9 0 0 1-9 9 9 9 0 0 1-6.7-3H3" />
    <path d="M3 21v-6h6" />
  </svg>
);
const IconX = ({ size = 16 }: { size?: number }) => (
  <svg {...iconAttrs(size)}>
    <path d="M18 6 6 18" />
    <path d="m6 6 12 12" />
  </svg>
);
const IconPlus = ({ size = 14 }: { size?: number }) => (
  <svg {...iconAttrs(size)}>
    <path d="M12 5v14" />
    <path d="M5 12h14" />
  </svg>
);
const IconCheck = ({ size = 14 }: { size?: number }) => (
  <svg {...iconAttrs(size, 2.4)}>
    <path d="M20 6 9 17l-5-5" />
  </svg>
);
const IconPrinter = ({ size = 15 }: { size?: number }) => (
  <svg {...iconAttrs(size)}>
    <path d="M6 9V2h12v7" />
    <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
    <path d="M6 14h12v8H6z" />
  </svg>
);
const IconEmpty = ({ size = 34 }: { size?: number }) => (
  <svg {...iconAttrs(size, 1.6)}>
    <path d="M3 7h18v13a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z" />
    <path d="M3 7 5.5 3h13L21 7" />
    <path d="M9 11h6" />
  </svg>
);

// ─── Helpers ──────────────────────────────────────────────────────────────

function freshnessLabel(iso: string): string {
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  if (mins < 1) return "just now";
  if (mins === 1) return "1 min ago";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  return hours === 1 ? "1 h ago" : `${hours} h ago`;
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

/** Where the run currently is, as one readable phrase. */
function positionLabel(batch: BatchView): string {
  if (batch.status === "MADE") return "Made";
  if (batch.status === "CLOSED") return "Archived";
  if (batch.status === "CANCELLED") return "Cancelled";
  return batch.stage ? STAGE_LABELS[batch.stage] : "Not started";
}

// ─── Printable run sheet ──────────────────────────────────────────────────

/**
 * The sheet that travels with the tray.
 *
 * Deliberately only four things: the run's name, the stage it is at, and a
 * grid of pictures with variants and quantities. It mirrors the pick list's
 * MANUFACTURING layout exactly — the bench already works from that sheet, so a
 * run sheet in a different shape would be a second format to learn.
 *
 * Everything else a run knows — orders, promised dates, surplus, losses,
 * reconciliation — is deliberately absent. The bench is being told what to
 * make, and every extra figure on the page is one more thing to read past.
 *
 * Rendered hidden on the page and lifted into a standalone document at print
 * time; see handlePrint for why it can't simply call window.print().
 */
function RunSheet({ batch }: { batch: BatchView }) {
  // Four to a row, matching the pick list grid.
  const rows = Math.ceil(batch.products.length / 4);

  return (
    <div id="batch-print">
      <header className="bp-head">
        <h1>{batch.name}</h1>
        <span className="bp-stage">{positionLabel(batch)}</span>
      </header>

      <table className="bpm">
        <tbody>
          {Array.from({ length: rows }).map((_, rowIndex) => (
            <tr key={rowIndex}>
              {[0, 1, 2, 3].map((colIndex) => {
                const product = batch.products[rowIndex * 4 + colIndex];
                return (
                  <td key={colIndex}>
                    {product && (
                      <div className="bpc">
                        {shopifyImg(product.imageUrl, PRINT_IMG_WIDTH) ? (
                          <img
                            src={shopifyImg(product.imageUrl, PRINT_IMG_WIDTH)!}
                            alt={product.productTitle}
                          />
                        ) : (
                          <div className="bpc-noimg">No image</div>
                        )}
                        <div className="bpc-body">
                          <div className="bpc-title">{product.productTitle}</div>
                          <div className="bpc-vars">
                            {product.finishes.map((finish) => (
                              <div key={finish.id} className="bpc-var-row">
                                {finish.variantTitle || "—"}: <b>{finish.quantity}</b>
                              </div>
                            ))}
                          </div>
                          {/* The raw count — what actually gets cast. The
                              finishes above are how it will be split later. */}
                          <div className="bpc-qty">{product.plannedQuantity}</div>
                        </div>
                      </div>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── Component ────────────────────────────────────────────────────────────

/** What the builder is doing: starting a run, or adding to an existing one. */
type BuilderMode = { kind: "create" } | { kind: "add"; batch: BatchView };

/**
 * A product the merchant has ticked, and how many RAW pieces to make of it.
 *
 * Carries its own identity rather than pointing back at a candidate, because a
 * pick can come from either source — outstanding orders or the product
 * catalogue — and the selection has to survive switching between them.
 *
 * There is no finish here on purpose: a raw piece has none until plating.
 */
interface PickedProduct {
  productId: string;
  productTitle: string;
  imageUrl: string | null;
  /** Outstanding pieces that still need making. Zero for a stock-only pick. */
  committed: number;
  /** Demand per finish, shown so the quantity is chosen with it in view. */
  demand: Array<{ variantTitle: string; pieces: number }>;
  qty: string;
}

/** One selectable row, from either source, in a shape the list can render. */
interface PickRow {
  productId: string;
  productTitle: string;
  imageUrl: string | null;
  committed: number;
  readyPieces: number;
  orders: number;
  demand: Array<{ variantTitle: string; pieces: number }>;
  earliestPromised: string | null;
}

/**
 * A valid opening allocation for the split dialog.
 *
 * The stored finish quantities are the seed made at creation, which stops
 * being valid the moment anything breaks — opening the dialog on "1 will exist
 * but 2 allocated" hands the merchant an error to solve before they can even
 * start. So the pieces that survived are dealt out here first.
 *
 * Soonest promised date first, because when there aren't enough to go round
 * that is the only defensible order to fill them in. Any surplus beyond what
 * is owed lands on the largest finish, and the merchant moves it from there.
 */
function suggestAllocation(product: BatchProductView): Record<string, string> {
  const byUrgency = [...product.finishes].sort((a, b) => {
    const dateOf = (variantId: string) =>
      product.lines
        .filter((l) => l.variantId === variantId && l.promisedDate)
        .map((l) => l.promisedDate!)
        .sort()[0] ?? "9999-12-31";
    const d = dateOf(a.variantId).localeCompare(dateOf(b.variantId));
    return d !== 0 ? d : b.committed - a.committed;
  });

  let left = product.made;
  const out: Record<string, string> = {};
  for (const finish of byUrgency) {
    const give = Math.min(finish.committed, left);
    out[finish.variantId] = String(give);
    left -= give;
  }
  if (left > 0 && byUrgency.length > 0) {
    const biggest = [...byUrgency].sort((a, b) => b.committed - a.committed)[0];
    out[biggest.variantId] = String((Number(out[biggest.variantId]) || 0) + left);
  }
  return out;
}

function rowFromCandidate(c: BatchCandidate): PickRow {
  return {
    productId: c.productId,
    productTitle: c.productTitle,
    imageUrl: c.imageUrl,
    committed: c.pieces,
    readyPieces: c.readyPieces,
    orders: c.lines.length,
    demand: c.variants.map((v) => ({
      variantTitle: v.variantTitle,
      pieces: v.pieces,
    })),
    earliestPromised: c.earliestPromised,
  };
}

export default function BatchPage() {
  const data = useFetcher<typeof dataLoader>();
  const act = useFetcher<typeof action>();
  const inventory = useFetcher<typeof inventoryLoader>();

  const loadedRef = useRef(false);
  useEffect(() => {
    if (loadedRef.current) return;
    loadedRef.current = true;
    data.load(DATA_ROUTE);
  }, [data]);

  const reload = useCallback(() => data.load(DATA_ROUTE), [data]);
  const refresh = useCallback(() => data.load(`${DATA_ROUTE}?force=1`), [data]);

  // Memoised for the same reason as the tracker's line list: `?? []` hands back
  // a new array every render, and these feed effect dependencies.
  const batches = useMemo(() => data.data?.batches ?? [], [data.data]);
  const candidates = useMemo(() => data.data?.candidates ?? [], [data.data]);
  const suggestions = useMemo(() => data.data?.suggestions ?? [], [data.data]);
  const readyToShipPieces = data.data?.readyToShipPieces ?? 0;
  const nextRunName = data.data?.nextRunName ?? "";
  const canWriteInventory = data.data?.canWriteInventory ?? false;
  const loadError = data.data?.error ?? null;
  const loading = data.state === "loading" || data.data === undefined;

  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [showArchived, setShowArchived] = useState(false);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  // Builder
  const [builder, setBuilder] = useState<BuilderMode | null>(null);
  const [picked, setPicked] = useState<Map<string, PickedProduct>>(new Map());
  const [runName, setRunName] = useState("");
  const [note, setNote] = useState("");
  const [builderSearch, setBuilderSearch] = useState("");
  /**
   * Which list the builder is showing. A run isn't limited to what has been
   * ordered — making stock nobody has asked for yet is half the point — so the
   * whole catalogue is reachable, with outstanding work as the default because
   * it is what usually prompts a run.
   */
  const [source, setSource] = useState<"orders" | "catalog">("orders");
  const products = useFetcher<typeof productsLoader>();

  // Stock dialog
  const [stockFor, setStockFor] = useState<BatchView | null>(null);
  const [locationId, setLocationId] = useState("");

  /**
   * The plating handler: which product's finishes are being allocated.
   *
   * `alloc` is variantId → pieces, as typed, so the running total can be shown
   * against what survived. It is only ever submitted as a complete set —
   * a half-entered split is not a valid state to store.
   */
  const [splitting, setSplitting] = useState<{
    batch: BatchView;
    product: BatchProductView;
  } | null>(null);
  const [alloc, setAlloc] = useState<Record<string, string>>({});

  const openSplit = (batch: BatchView, product: BatchProductView) => {
    setSplitting({ batch, product });
    setAlloc(suggestAllocation(product));
    setActionError(null);
  };

  // The run whose sheet is currently rendered (hidden) for printing.
  const [printing, setPrinting] = useState<BatchView | null>(null);
  const shopify = useAppBridge();

  /**
   * Print a run sheet.
   *
   * Copies the pick list's approach, and for the same two reasons: this page
   * lives in a Shopify iframe, where an in-frame window.print() prints the
   * wrong frame; and the Shopify NATIVE mobile app's WebView blocks both
   * printing and opening documents, with no web print API to fall back on. So
   * the sheet is written into a real top-level document, and if that can't be
   * opened the merchant is told what to do instead of watching nothing happen.
   */
  const handlePrint = useCallback(
    (batch: BatchView) => {
      const cannotPrint = () =>
        shopify.toast.show(
          "Printing isn't available inside the Shopify mobile app. Open your store in a browser (desktop, or Safari/Chrome on your phone) to print or save as PDF.",
          { isError: true, duration: 6000 }
        );

      // Commit the hidden sheet to the DOM before reading its markup.
      flushSync(() => setPrinting(batch));

      const src = document.getElementById("batch-print");
      if (!src) {
        setPrinting(null);
        cannotPrint();
        return;
      }

      const win = window.open("", "_blank");
      if (!win) {
        setPrinting(null);
        cannotPrint();
        return;
      }

      try {
        win.document.open();
        win.document.write(
          '<!doctype html><html><head><meta charset="utf-8">' +
            '<meta name="viewport" content="width=device-width,initial-scale=1">' +
            "<title>" +
            batch.name.replace(/[<>&]/g, "") +
            " — run sheet</title><style>" +
            PRINT_DOC_TOKENS +
            "html,body{margin:0;background:#fff;color:#201e1d;font-family:var(--font-body);}" +
            BATCH_PRINT_CSS +
            "#batch-print{padding:18px;}" +
            ".bp-bar{position:sticky;top:0;z-index:9;display:flex;gap:8px;padding:12px 16px;" +
            "background:#f3f2f2;border-bottom:2px solid #201e1d;}" +
            ".bp-bar button{font-family:var(--font-heading);font-weight:800;font-size:14px;" +
            "padding:11px 18px;border:1px solid #201e1d;background:#ec3013;color:#fff;cursor:pointer;}" +
            "@media print{.bp-bar{display:none;}#batch-print{padding:0;}}" +
            "@page{size:A4 portrait;margin:10mm;}" +
            "</style></head><body>" +
            '<div class="bp-bar"><button onclick="window.print()">Print / Save as PDF</button></div>' +
            src.outerHTML +
            // Wait for images before opening the dialog, or the sheet prints
            // with empty boxes where the pieces should be. The button above is
            // the fallback if a browser blocks the automatic call.
            "<scr" + "ipt>window.addEventListener('load',function(){" +
            "setTimeout(function(){try{window.focus();window.print();}catch(e){}},500);});</scr" +
            "ipt></body></html>"
        );
        win.document.close();
      } catch {
        try {
          win.close();
        } catch {
          /* ignore */
        }
        cannotPrint();
      } finally {
        setPrinting(null);
      }
    },
    [shopify]
  );

  const busy = act.state !== "idle";

  /**
   * React to a finished action exactly once.
   *
   * fetcher.data KEEPS its value after the fetcher goes idle, so without the
   * identity guard this effect re-fires on the re-render its own reload
   * causes — the same endless loop the tracker hit.
   */
  const handled = useRef<unknown>(null);
  useEffect(() => {
    if (act.state !== "idle") return;
    const result = act.data;
    if (!result || handled.current === result) return;
    handled.current = result;

    if (result.ok) {
      setActionError(null);
      if (result.stock) setNotice(result.stock);
      setBuilder(null);
      setStockFor(null);
      setSplitting(null);
      reload();
    } else {
      setActionError(result.error ?? "Couldn't save that change.");
    }
  }, [act.state, act.data, reload]);

  // Load live stock only when the dialog opens — never on page load.
  useEffect(() => {
    if (!stockFor) return;
    setLocationId("");
    inventory.load(`${INVENTORY_ROUTE}?batchId=${encodeURIComponent(stockFor.id)}`);
    // `inventory` is a stable fetcher; depending on it would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stockFor?.id]);

  // Default to whichever location covers the most of the run.
  useEffect(() => {
    const locs = inventory.data?.locations ?? [];
    if (locs.length > 0) setLocationId(locs[0].locationId);
  }, [inventory.data]);

  /**
   * Catalogue search, debounced.
   *
   * Unlike the outstanding-work list this is a live Shopify query, so it fires
   * on a pause rather than per keystroke. It also runs once with an empty term
   * when the tab opens, which returns the first page of the catalogue — the
   * builder should never show an empty list waiting to be typed into.
   */
  useEffect(() => {
    if (!builder || source !== "catalog") return;
    const timer = setTimeout(() => {
      products.load(`${PRODUCTS_ROUTE}?q=${encodeURIComponent(builderSearch)}`);
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
    // `products` is a stable fetcher; depending on it would re-fire endlessly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [builder, source, builderSearch]);

  /**
   * The plating handler needs every variant of the product, not just the ones
   * with orders — plating pieces nobody has asked for is the normal case.
   */
  useEffect(() => {
    if (!splitting) return;
    products.load(
      `${PRODUCTS_ROUTE}?productId=${encodeURIComponent(splitting.product.productId)}`
    );
    // `products` is a stable fetcher; depending on it would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [splitting?.product.productId]);

  // Escape closes whichever overlay is open.
  useEffect(() => {
    if (!builder && !stockFor && !splitting) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setBuilder(null);
      setStockFor(null);
      setSplitting(null);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [builder, stockFor, splitting]);

  const submit = (fields: Record<string, string | string[]>) => {
    setActionError(null);
    setNotice(null);
    const body = new FormData();
    for (const [key, value] of Object.entries(fields)) {
      if (Array.isArray(value)) value.forEach((v) => body.append(key, v));
      else body.append(key, value);
    }
    act.submit(body, { method: "POST" });
  };

  const openBuilder = (mode: BuilderMode, seed?: BatchCandidate) => {
    setBuilder(mode);
    setPicked(
      seed ? new Map([[seed.productId, pickFrom(rowFromCandidate(seed))]]) : new Map()
    );
    // Blank if the page hasn't loaded its data yet — the server allocates the
    // number on save, so an empty field still produces a correctly named run.
    setRunName(mode.kind === "create" ? nextRunName : "");
    setNote("");
    setBuilderSearch("");
    setSource("orders");
    setActionError(null);
  };

  /** A product with no outstanding orders still has to make at least one. */
  const pickFrom = (row: PickRow): PickedProduct => ({
    productId: row.productId,
    productTitle: row.productTitle,
    imageUrl: row.imageUrl,
    committed: row.committed,
    demand: row.demand,
    qty: String(row.committed || 1),
  });

  const togglePick = (row: PickRow) => {
    setPicked((current) => {
      const next = new Map(current);
      if (next.has(row.productId)) next.delete(row.productId);
      else next.set(row.productId, pickFrom(row));
      return next;
    });
  };

  const setQty = (productId: string, qty: string) => {
    setPicked((current) => {
      const existing = current.get(productId);
      if (!existing) return current;
      return new Map(current).set(productId, { ...existing, qty });
    });
  };

  const toggleSet = (set: Set<string>, id: string) => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  };

  // ── Derived ─────────────────────────────────────────────────────────────

  const q = search.trim().toLowerCase();
  const matches = (text: string[], needle: string) =>
    !needle || text.some((t) => t.toLowerCase().includes(needle));

  const liveBatches = batches.filter((b) => b.status !== "CLOSED");
  const archived = batches.filter((b) => b.status === "CLOSED");

  const visibleBatches = liveBatches.filter((b) =>
    matches(
      [
        b.name,
        ...b.products.flatMap((p) => [
          p.productTitle,
          ...p.finishes.map((f) => f.variantTitle),
        ]),
      ],
      q
    )
  );
  const visibleCandidates = candidates.filter((c) =>
    matches(
      [c.productTitle, ...c.variants.flatMap((v) => [v.variantTitle, v.sku ?? ""])],
      q
    )
  );

  const openRuns = liveBatches.filter((b) => b.status === "OPEN");
  const piecesInProduction = openRuns.reduce((sum, b) => sum + b.plannedTotal, 0);
  const surplusPending = liveBatches.reduce((sum, b) => sum + b.surplusTotal, 0);
  const unbatchedPieces = candidates.reduce((sum, c) => sum + c.pieces, 0);

  // Builder rows. Outstanding work is filtered locally (it's already loaded);
  // the catalogue comes back pre-filtered from Shopify.
  const byProductCandidate = useMemo(
    () => new Map(candidates.map((c) => [c.productId, c])),
    [candidates]
  );

  /**
   * Shopify searches VARIANTS, but a run is built from products — so the
   * results are collapsed by product here. Each row is then cross-referenced
   * against outstanding work, so picking a product from the catalogue means
   * exactly what picking it from the orders list means.
   */
  const catalogueRows: PickRow[] = useMemo(() => {
    const byProduct = new Map<string, PickRow>();
    for (const v of products.data?.variants ?? []) {
      if (byProduct.has(v.productId)) continue;
      const c = byProductCandidate.get(v.productId);
      byProduct.set(v.productId, {
        productId: v.productId,
        productTitle: v.productTitle,
        imageUrl: v.imageUrl,
        committed: c?.pieces ?? 0,
        readyPieces: c?.readyPieces ?? 0,
        orders: c?.lines.length ?? 0,
        demand:
          c?.variants.map((x) => ({
            variantTitle: x.variantTitle,
            pieces: x.pieces,
          })) ?? [],
        earliestPromised: c?.earliestPromised ?? null,
      });
    }
    return [...byProduct.values()];
  }, [products.data, byProductCandidate]);

  const builderRows: PickRow[] =
    source === "orders"
      ? candidates
          .filter((c) =>
            matches(
              [
                c.productTitle,
                ...c.variants.flatMap((v) => [v.variantTitle, v.sku ?? ""]),
              ],
              builderSearch.trim().toLowerCase()
            )
          )
          .map(rowFromCandidate)
      : catalogueRows;

  // Builder arithmetic, live as you type. Driven by the picks themselves, not
  // by either list, so switching source never disturbs the totals.
  const pickedList = [...picked.values()];
  const builderCommitted = pickedList.reduce((sum, p) => sum + p.committed, 0);
  const builderPlanned = pickedList.reduce(
    (sum, p) => sum + (Number(p.qty) || 0),
    0
  );
  const builderSurplus = surplusOf(builderPlanned, builderCommitted);

  /**
   * Every finish the split can allocate to.
   *
   * The run's existing finishes come from what was ordered — but the whole
   * point of the plating handler is deciding to plate pieces nobody ordered
   * yet, so the product's other variants have to be offered too. They arrive
   * from the catalogue lookup fired when the dialog opens.
   */
  const splitOptions = useMemo(() => {
    if (!splitting) return [];
    const { product } = splitting;

    const seen = new Map<
      string,
      {
        variantId: string;
        variantTitle: string;
        doneAtSplit: boolean;
        remaining: TrackStage[];
      }
    >();

    for (const finish of product.finishes) {
      seen.set(finish.variantId, {
        variantId: finish.variantId,
        variantTitle: finish.variantTitle,
        doneAtSplit: finish.doneAtSplit,
        remaining: finish.remainingStages,
      });
    }

    for (const v of products.data?.variants ?? []) {
      if (v.productId !== product.productId || seen.has(v.variantId)) continue;
      // A variant with no run history yet: assume it takes every stage from
      // the split onward. Its route is corrected once, then remembered.
      const remaining = product.splitStage
        ? STAGES.filter(
            (s) => STAGES.indexOf(s) >= STAGES.indexOf(product.splitStage!)
          )
        : [];
      seen.set(v.variantId, {
        variantId: v.variantId,
        variantTitle: v.variantTitle,
        doneAtSplit: remaining.length === 0,
        remaining,
      });
    }

    return [...seen.values()];
  }, [splitting, products.data]);

  /** What each finish owes to orders — the floor for its allocation. */
  const splitDemand = useMemo(() => {
    const demand = new Map<string, number>();
    for (const line of splitting?.product.lines ?? []) {
      if (line.liveQuantity === null) continue;
      demand.set(
        line.variantId,
        (demand.get(line.variantId) ?? 0) + line.liveQuantity
      );
    }
    return demand;
  }, [splitting]);

  const splitTotal = splitOptions.reduce(
    (sum, o) => sum + (Number(alloc[o.variantId]) || 0),
    0
  );
  const splitLeft = (splitting?.product.made ?? 0) - splitTotal;

  /**
   * Finishes allocated less than they owe.
   *
   * Only a blocker when the run can actually cover every order. Once breakage
   * has eaten past the surplus this is unavoidable — the pieces don't exist —
   * so it becomes a statement of which orders go unfilled rather than an error
   * standing between the merchant and a decision they've already had to make.
   */
  const splitOwedTotal = [...splitDemand.values()].reduce((s, n) => s + n, 0);
  const splitCanCoverAll = (splitting?.product.made ?? 0) >= splitOwedTotal;
  const splitUnfilled = splitOptions
    .map((o) => ({
      title: o.variantTitle || "—",
      missing:
        (splitDemand.get(o.variantId) ?? 0) - (Number(alloc[o.variantId]) || 0),
    }))
    .filter((x) => x.missing > 0);
  const splitShort = splitCanCoverAll ? splitUnfilled.map((x) => x.title) : [];

  const stockLocations = inventory.data?.locations ?? [];
  const stockVariants = inventory.data?.variants ?? [];
  const inventoryLoading = inventory.state !== "idle";

  return (
    <>
      <style>{BATCH_CSS}</style>

      {/* Mounted only while printing, off-screen. Its markup is what gets
          lifted into the standalone document; keeping it laid out (rather than
          display:none) also warms the image cache for that new tab. */}
      {printing && (
        <div className="bt-printsrc" aria-hidden="true">
          <style>{BATCH_PRINT_CSS}</style>
          <RunSheet batch={printing} />
        </div>
      )}

      <div className="bt-app">
        <div className="bt-page">
          <header className="bt-header">
            <div>
              <p className="bt-eyebrow">Vellismith · Production</p>
              <h1>Batches</h1>
            </div>
            <div className="bt-head-actions">
              {busy && <span className="bt-saving">Saving…</span>}
              {!loading && data.data?.fetchedAt && (
                <span
                  className="bt-freshness"
                  title={
                    data.data.cached
                      ? "Order list served from cache. Refresh re-reads Shopify."
                      : "Order list read from Shopify just now."
                  }
                >
                  Orders {freshnessLabel(data.data.fetchedAt)}
                </span>
              )}
              <button
                className="btn"
                onClick={refresh}
                disabled={data.state !== "idle"}
              >
                <IconRefresh />
                {data.state !== "idle" ? "Refreshing…" : "Refresh"}
              </button>
              {/* Enabled even with no outstanding work: a run can be built
                  entirely from the catalogue to make stock. */}
              <button
                className="btn btn-primary"
                disabled={loading}
                onClick={() => openBuilder({ kind: "create" })}
              >
                <IconPlus /> New run
              </button>
            </div>
          </header>

          <div className="bt-stats">
            <div>
              <div className="bt-stat-n">{openRuns.length}</div>
              <div className="bt-stat-l">Runs in production</div>
            </div>
            <div>
              <div className="bt-stat-n bt-accent">{piecesInProduction}</div>
              <div className="bt-stat-l">Pieces being made</div>
            </div>
            <div>
              <div className="bt-stat-n">{surplusPending}</div>
              <div className="bt-stat-l">Surplus to stock</div>
            </div>
            <div className="bt-stat-last">
              <div className="bt-stat-n">{unbatchedPieces}</div>
              <div className="bt-stat-l">Still to make</div>
              {readyToShipPieces > 0 && (
                <div className="bt-stat-sub">
                  +{readyToShipPieces} already ready to ship
                </div>
              )}
            </div>
          </div>

          <p className="bt-legend">
            A run makes many variants together. Per variant, <b>planned</b>{" "}
            pieces are made, <b>committed</b> go to orders, and the{" "}
            <b>surplus</b> becomes stock. The whole planned quantity is what
            gets written to Shopify — it already holds the ordered pieces back
            as committed, so only the surplus becomes sellable.
          </p>

          <div className="bt-toolbar">
            <input
              className="input"
              placeholder="Search runs, products, variants or SKUs…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>

          {(loadError || actionError) && (
            <div className="bt-error">{loadError ?? actionError}</div>
          )}
          {notice && <div className="bt-notice">{notice}</div>}

          {/* Orders that need nothing made — a run already has spare pieces
              for them. Listed rather than applied silently: taking an order
              into a run also moves it on the tracker board, which is too much
              to do as a side effect of opening a page. */}
          {suggestions.length > 0 && (
            <div className="bt-suggest">
              <div className="bt-suggest-head">
                <span>
                  <b>{suggestions.length}</b>{" "}
                  {suggestions.length === 1 ? "order can" : "orders can"} be
                  filled from surplus — nothing new to make
                </span>
                <span className="bt-suggest-acts">
                  <button
                    className="bt-mini"
                    onClick={() => setShowSuggestions((v) => !v)}
                  >
                    {showSuggestions ? "Hide" : "Review"}
                  </button>
                  <button
                    className="btn btn-primary"
                    disabled={busy}
                    onClick={() => submit({ intent: "auto-allocate" })}
                  >
                    {busy ? "Allocating…" : "Allocate all"}
                  </button>
                </span>
              </div>
              {showSuggestions && (
                <div className="bt-suggest-list">
                  {suggestions.map((s) => (
                    <div key={s.lineItemId} className="bt-suggest-row">
                      <span className="bt-suggest-order">{s.orderName}</span>
                      <span className="bt-suggest-what">
                        {s.productTitle}
                        {s.variantTitle ? ` · ${s.variantTitle}` : ""} ×
                        {s.quantity}
                        {s.promisedDate
                          ? ` · due ${formatPromisedDate(s.promisedDate)}`
                          : ""}
                      </span>
                      <span className="bt-suggest-to">
                        → {s.batchName} (
                        {s.batchStage ? STAGE_LABELS[s.batchStage] : "not started"}
                        , {s.spareAfter} left)
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
          {!canWriteInventory && !loading && (
            <div className="bt-warn-box">
              Stock updates are unavailable until the app is re-authorised with
              inventory permissions. Runs still work as a planning tool in the
              meantime.
            </div>
          )}

          {/* ── Runs ───────────────────────────────────────────────────── */}

          <section className="bt-section">
            <h2>In production</h2>
            {loading ? (
              <div className="bt-skel-list">
                <div className="bt-skel" />
                <div className="bt-skel" />
              </div>
            ) : visibleBatches.length === 0 ? (
              <div className="bt-empty">
                <IconEmpty />
                <p>
                  {liveBatches.length === 0
                    ? "No runs yet. Start one from the outstanding work below."
                    : "No runs match that search."}
                </p>
              </div>
            ) : (
              <div className="bt-runs">
                {visibleBatches.map((batch) => (
                  <BatchCard
                    key={batch.id}
                    batch={batch}
                    busy={busy}
                    canWriteInventory={canWriteInventory}
                    expanded={expanded}
                    onToggleExpand={(id) => setExpanded((s) => toggleSet(s, id))}
                    onSubmit={submit}
                    onStock={() => setStockFor(batch)}
                    onAddVariants={() => openBuilder({ kind: "add", batch })}
                    onPrint={() => handlePrint(batch)}
                    onSplit={(product) => openSplit(batch, product)}
                  />
                ))}
              </div>
            )}
          </section>

          {/* ── Candidates ─────────────────────────────────────────────── */}

          <section className="bt-section">
            <h2>
              Ready to batch
              {!loading && (
                <span className="bt-count">{visibleCandidates.length}</span>
              )}
            </h2>
            <p className="bt-legend">
              Outstanding work no run has claimed, grouped by variant. Tap one
              to start a run with it, then add more variants — including
              products with no orders at all — in the builder.
              {readyToShipPieces > 0 && (
                <>
                  {" "}
                  Pieces already marked <b>Ready to ship</b> are left out of
                  these counts: they exist, so there is nothing to make.
                </>
              )}
            </p>

            {loading ? (
              <div className="bt-skel-list">
                <div className="bt-skel" />
                <div className="bt-skel" />
                <div className="bt-skel" />
              </div>
            ) : visibleCandidates.length === 0 ? (
              <div className="bt-empty">
                <IconEmpty />
                <p>
                  {candidates.length === 0
                    ? "Every outstanding line is already in a run."
                    : "Nothing matches that search."}
                </p>
              </div>
            ) : (
              <div className="bt-cands">
                {visibleCandidates.map((c) => (
                  <button
                    key={c.productId}
                    className="bt-cand"
                    onClick={() => openBuilder({ kind: "create" }, c)}
                  >
                    {shopifyImg(c.imageUrl, 120) ? (
                      <img
                        className="bt-thumb"
                        src={shopifyImg(c.imageUrl, 120)!}
                        alt=""
                        loading="lazy"
                      />
                    ) : (
                      <div className="bt-thumb bt-thumb-blank" />
                    )}
                    <div className="bt-cand-main">
                      <div className="bt-cand-title">{c.productTitle}</div>
                      {/* Demand per finish, so the casting number is chosen
                          knowing what the split will have to cover. */}
                      <div className="bt-cand-sub">
                        {c.variants
                          .map((v) => `${v.pieces} ${v.variantTitle || "—"}`)
                          .join(" · ")}
                      </div>
                      {c.earliestPromised && (
                        <div className="bt-cand-due">
                          Earliest promised{" "}
                          {formatPromisedDate(c.earliestPromised)}
                        </div>
                      )}
                    </div>
                    <div className="bt-cand-nums">
                      <b>{c.pieces}</b>
                      <span>
                        to make · {c.lines.length}{" "}
                        {c.lines.length === 1 ? "order" : "orders"}
                      </span>
                      {c.readyPieces > 0 && (
                        <span className="bt-cand-ready">
                          {c.readyPieces} ready to ship
                        </span>
                      )}
                    </div>
                    <span className="bt-cand-go">
                      <IconPlus /> Run
                    </span>
                  </button>
                ))}
              </div>
            )}
          </section>

          {/* ── Archive ────────────────────────────────────────────────── */}

          {archived.length > 0 && (
            <section className="bt-section">
              <button
                className="bt-archive-toggle"
                onClick={() => setShowArchived((v) => !v)}
              >
                {showArchived ? "Hide" : "Show"} archived runs ({archived.length})
              </button>
              {showArchived && (
                <div className="bt-runs">
                  {archived.map((batch) => (
                    <BatchCard
                      key={batch.id}
                      batch={batch}
                      busy={busy}
                      canWriteInventory={canWriteInventory}
                      expanded={expanded}
                      onToggleExpand={(id) => setExpanded((s) => toggleSet(s, id))}
                      onSubmit={submit}
                      onStock={() => setStockFor(batch)}
                      onAddVariants={() => openBuilder({ kind: "add", batch })}
                      onPrint={() => handlePrint(batch)}
                      onSplit={(product) => openSplit(batch, product)}
                    />
                  ))}
                </div>
              )}
            </section>
          )}
        </div>
      </div>

      {/* ── Builder ──────────────────────────────────────────────────────── */}

      {builder && (
        <div className="bt-overlay">
          {/* A real button rather than a click handler on the backdrop div:
              tapping outside to dismiss is a mouse-only gesture, so this gives
              keyboard users the same escape hatch and screen readers something
              they can actually announce. */}
          <button
            type="button"
            className="bt-backdrop"
            aria-label="Close without saving"
            onClick={() => setBuilder(null)}
          />
          <div
            className="bt-sheet bt-sheet-wide"
            role="dialog"
            aria-modal="true"
            aria-label={builder.kind === "create" ? "New run" : "Add variants"}
          >
            <header className="bt-sheet-head">
              <div>
                <div className="bt-sheet-title">
                  {builder.kind === "create" ? "New run" : "Add to run"}
                </div>
                <div className="bt-sheet-sub">
                  {builder.kind === "create"
                    ? "Pick every variant this run will make."
                    : builder.batch.name}
                </div>
              </div>
              <button
                className="bt-icon-btn"
                onClick={() => setBuilder(null)}
                aria-label="Close"
              >
                <IconX />
              </button>
            </header>

            <div className="bt-sheet-body">
              {builder.kind === "create" && (
                <div className="bt-field">
                  <label htmlFor="bt-name">Run name</label>
                  <input
                    id="bt-name"
                    className="input"
                    maxLength={BATCH_NAME_MAX}
                    placeholder={nextRunName || "Numbered automatically"}
                    value={runName}
                    onChange={(e) => setRunName(e.target.value)}
                  />
                </div>
              )}

              {/* Running totals, pinned above the list so the arithmetic is
                  visible while picking rather than only at the end. */}
              <div className="bt-maths bt-maths-sticky">
                <div>
                  <b>{picked.size}</b>
                  <span>products</span>
                </div>
                <div>
                  <b>{builderPlanned}</b>
                  <span>planned</span>
                </div>
                <div>
                  <b>{builderCommitted}</b>
                  <span>committed</span>
                </div>
                <div className="bt-maths-surplus">
                  <b>{builderSurplus}</b>
                  <span>surplus</span>
                </div>
              </div>

              {/* Picks stay listed here whichever source they came from, so
                  switching tabs or searching never hides what is already in
                  the run — and every quantity stays editable in one place. */}
              {pickedList.length > 0 && (
                <div className="bt-chosen">
                  <div className="bt-chosen-head">
                    <span>In this run</span>
                    <button className="bt-mini" onClick={() => setPicked(new Map())}>
                      Clear all
                    </button>
                  </div>
                  {pickedList.map((p) => (
                    <div key={p.productId} className="bt-chosen-row">
                      <span className="bt-pick-text">
                        <span className="bt-pick-title">{p.productTitle}</span>
                        <span className="bt-pick-sub">
                          {p.committed > 0
                            ? `${p.committed} on order` +
                              (p.demand.length > 0
                                ? ` — ${p.demand
                                    .map(
                                      (d) => `${d.pieces} ${d.variantTitle || "—"}`
                                    )
                                    .join(", ")}`
                                : "")
                            : "stock only"}
                        </span>
                      </span>
                      <label className="bt-qtycell">
                        <span className="bt-sr">
                          Raw pieces to make of {p.productTitle}
                        </span>
                        <input
                          className="input bt-qty-input"
                          type="number"
                          min={Math.max(p.committed, 1)}
                          inputMode="numeric"
                          value={p.qty}
                          onChange={(e) => setQty(p.productId, e.target.value)}
                        />
                      </label>
                      <button
                        className="bt-icon-btn"
                        aria-label={`Remove ${p.productTitle}`}
                        onClick={() =>
                          setPicked((m) => {
                            const next = new Map(m);
                            next.delete(p.productId);
                            return next;
                          })
                        }
                      >
                        <IconX size={14} />
                      </button>
                    </div>
                  ))}
                </div>
              )}

              <div className="bt-tabs" role="tablist">
                <button
                  role="tab"
                  aria-selected={source === "orders"}
                  className={source === "orders" ? "bt-tab on" : "bt-tab"}
                  onClick={() => setSource("orders")}
                >
                  Outstanding work ({candidates.length})
                </button>
                <button
                  role="tab"
                  aria-selected={source === "catalog"}
                  className={source === "catalog" ? "bt-tab on" : "bt-tab"}
                  onClick={() => setSource("catalog")}
                >
                  All products
                </button>
              </div>

              <div className="bt-field">
                <label htmlFor="bt-bsearch" className="bt-sr">
                  Find variants
                </label>
                <input
                  id="bt-bsearch"
                  className="input"
                  placeholder={
                    source === "orders"
                      ? "Filter outstanding work…"
                      : "Search the whole catalogue…"
                  }
                  value={builderSearch}
                  onChange={(e) => setBuilderSearch(e.target.value)}
                />
              </div>

              {source === "catalog" && products.data?.error && (
                <div className="bt-error">{products.data.error}</div>
              )}

              <div className="bt-picker">
                {source === "catalog" && products.state !== "idle" ? (
                  <p className="bt-lines-empty">Searching…</p>
                ) : builderRows.length === 0 ? (
                  <p className="bt-lines-empty">
                    {source === "orders"
                      ? "No outstanding work matches that."
                      : "No products match that search."}
                  </p>
                ) : (
                  builderRows.map((row) => {
                    const on = picked.has(row.productId);
                    return (
                      <div
                        key={row.productId}
                        className={on ? "bt-pickrow on" : "bt-pickrow"}
                      >
                        <button
                          type="button"
                          className="bt-pickmain"
                          onClick={() => togglePick(row)}
                        >
                          <span className="bt-pick-box">
                            {on && <IconCheck />}
                          </span>
                          {shopifyImg(row.imageUrl, 80) ? (
                            <img
                              className="bt-thumb bt-thumb-sm"
                              src={shopifyImg(row.imageUrl, 80)!}
                              alt=""
                              loading="lazy"
                            />
                          ) : (
                            <span className="bt-thumb bt-thumb-sm bt-thumb-blank" />
                          )}
                          <span className="bt-pick-text">
                            <span className="bt-pick-title">
                              {row.productTitle}
                            </span>
                            <span className="bt-pick-sub">
                              {[
                                row.committed > 0
                                  ? `${row.committed} to make` +
                                    (row.demand.length > 1
                                      ? ` (${row.demand
                                          .map(
                                            (d) =>
                                              `${d.pieces} ${d.variantTitle || "—"}`
                                          )
                                          .join(", ")})`
                                      : "")
                                  : "no orders waiting",
                                row.readyPieces > 0
                                  ? `${row.readyPieces} already ready`
                                  : null,
                                row.earliestPromised
                                  ? `due ${formatPromisedDate(row.earliestPromised)}`
                                  : null,
                              ]
                                .filter(Boolean)
                                .join(" · ")}
                            </span>
                          </span>
                        </button>
                      </div>
                    );
                  })
                )}
              </div>

              {builder.kind === "create" && (
                <div className="bt-field bt-field-top">
                  <label htmlFor="bt-note">Note (optional)</label>
                  <input
                    id="bt-note"
                    className="input"
                    maxLength={BATCH_NOTE_MAX}
                    placeholder="Alloy, stone source, anything worth remembering"
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                  />
                </div>
              )}
            </div>

            <footer className="bt-sheet-foot">
              <button
                className="btn"
                onClick={() => setBuilder(null)}
                disabled={busy}
              >
                Cancel
              </button>
              <button
                className="btn btn-primary"
                disabled={busy || picked.size === 0}
                onClick={() => {
                  const productIds = [...picked.keys()];
                  const quantities: Record<string, string> = {};
                  for (const p of pickedList) {
                    // Never send less than is owed, and never zero. The server
                    // enforces both, but sending a sane value keeps what was
                    // confirmed on screen and what gets stored identical.
                    quantities[`${QTY_PREFIX}${p.productId}`] = String(
                      Math.max(Number(p.qty) || 0, p.committed, 1)
                    );
                  }
                  submit({
                    intent: builder.kind === "create" ? "create" : "add-products",
                    ...(builder.kind === "add"
                      ? { batchId: builder.batch.id }
                      : { name: runName, note }),
                    productId: productIds,
                    ...quantities,
                  });
                }}
              >
                {busy
                  ? "Saving…"
                  : builder.kind === "create"
                    ? `Create run (${picked.size})`
                    : `Add ${picked.size} product${picked.size === 1 ? "" : "s"}`}
              </button>
            </footer>
          </div>
        </div>
      )}

      {/* ── The plating handler ──────────────────────────────────────────── */}

      {splitting && (
        <div className="bt-overlay">
          <button
            type="button"
            className="bt-backdrop"
            aria-label="Close without setting finishes"
            onClick={() => setSplitting(null)}
          />
          <div
            className="bt-sheet"
            role="dialog"
            aria-modal="true"
            aria-label="Set finishes"
          >
            <header className="bt-sheet-head">
              <div>
                <div className="bt-sheet-title">
                  {splitting.product.made} pieces to finish
                </div>
                <div className="bt-sheet-sub">
                  {splitting.product.productTitle}
                  {splitting.product.scrapped > 0
                    ? ` · ${splitting.product.plannedQuantity} made, ${splitting.product.scrapped} lost`
                    : ""}
                </div>
              </div>
              <button
                className="bt-icon-btn"
                onClick={() => setSplitting(null)}
                aria-label="Close"
              >
                <IconX />
              </button>
            </header>

            <div className="bt-sheet-body">
              <p className="bt-inline-note" style={{ marginTop: 0 }}>
                Up to here every piece has been the same. Say how many carry
                each finish — anything with stages left goes on through the
                workshop, the rest are ready to ship.
              </p>

              {/* Breakage has left fewer pieces than orders. Nothing can make
                  that allocation "correct", so the dialog stops asking for one
                  and asks which order waits instead. */}
              {!splitCanCoverAll && (
                <div className="bt-warn-box">
                  Only {splitting.product.made}{" "}
                  {splitting.product.made === 1 ? "piece" : "pieces"} survived
                  but {splitOwedTotal} are on order. Some cannot be filled —
                  choose which finishes get the pieces, then start another run
                  for the rest.
                </div>
              )}

              <div className="bt-chosen">
                {splitOptions.map((option) => {
                  const owed = splitDemand.get(option.variantId) ?? 0;
                  return (
                    <div key={option.variantId} className="bt-chosen-row">
                      <span className="bt-pick-text">
                        <span className="bt-pick-title">
                          {option.variantTitle || "—"}
                        </span>
                        <span className="bt-pick-sub">
                          {owed > 0 ? `${owed} on order · ` : ""}
                          {option.doneAtSplit
                            ? "finished once allocated"
                            : `still needs ${option.remaining
                                .map((s) => STAGE_LABELS[s])
                                .join(", ")}`}
                        </span>
                      </span>
                      <label className="bt-qtycell">
                        <span className="bt-sr">
                          Pieces finished as {option.variantTitle}
                        </span>
                        <input
                          className="input bt-qty-input"
                          type="number"
                          min={owed}
                          inputMode="numeric"
                          value={alloc[option.variantId] ?? "0"}
                          onChange={(e) =>
                            setAlloc((a) => ({
                              ...a,
                              [option.variantId]: e.target.value,
                            }))
                          }
                        />
                      </label>
                    </div>
                  );
                })}
              </div>

              {/* The running total, because the split is only valid as a set
                  that accounts for every surviving piece. */}
              <div className="bt-maths" style={{ marginTop: 14 }}>
                <div>
                  <b>{splitting.product.made}</b>
                  <span>will exist</span>
                </div>
                <div>
                  <b>{splitTotal}</b>
                  <span>allocated</span>
                </div>
                <div className={splitLeft === 0 ? undefined : "bt-maths-surplus"}>
                  <b>{splitLeft}</b>
                  <span>{splitLeft < 0 ? "over" : "left"}</span>
                </div>
              </div>

              {splitLeft !== 0 && (
                <p className="bt-inline-warn">
                  {splitLeft > 0
                    ? `${splitLeft} ${splitLeft === 1 ? "piece has" : "pieces have"} no finish yet.`
                    : `${-splitLeft} more allocated than will exist.`}
                </p>
              )}
              {splitShort.length > 0 && (
                <p className="bt-inline-warn">
                  Below what is owed: {splitShort.join(", ")}. There are enough
                  pieces to cover every order.
                </p>
              )}
              {/* When the pieces genuinely aren't there, name the consequence
                  rather than blocking: these are the orders that go unfilled. */}
              {!splitCanCoverAll && splitUnfilled.length > 0 && (
                <p className="bt-inline-warn">
                  Will go unfilled:{" "}
                  {splitUnfilled
                    .map((x) => `${x.missing} × ${x.title}`)
                    .join(", ")}
                  .
                </p>
              )}
            </div>

            <footer className="bt-sheet-foot">
              <button
                className="btn"
                onClick={() => setSplitting(null)}
                disabled={busy}
              >
                Cancel
              </button>
              <button
                className="btn btn-primary"
                disabled={busy || splitLeft !== 0 || splitShort.length > 0}
                onClick={() =>
                  submit({
                    intent: "split",
                    batchId: splitting.batch.id,
                    batchProductId: splitting.product.id,
                    ...Object.fromEntries(
                      splitOptions.map((o) => [
                        `${FINISH_PREFIX}${o.variantId}`,
                        String(Number(alloc[o.variantId]) || 0),
                      ])
                    ),
                  })
                }
              >
                {busy ? "Saving…" : "Set finishes"}
              </button>
            </footer>
          </div>
        </div>
      )}

      {/* ── Stock dialog ─────────────────────────────────────────────────── */}

      {stockFor && (
        <div className="bt-overlay">
          <button
            type="button"
            className="bt-backdrop"
            aria-label="Close without updating stock"
            onClick={() => setStockFor(null)}
          />
          <div
            className="bt-sheet bt-sheet-wide"
            role="dialog"
            aria-modal="true"
            aria-label="Update stock"
          >
            <header className="bt-sheet-head">
              <div>
                <div className="bt-sheet-title">Add this run to stock</div>
                <div className="bt-sheet-sub">{stockFor.name}</div>
              </div>
              <button
                className="bt-icon-btn"
                onClick={() => setStockFor(null)}
                aria-label="Close"
              >
                <IconX />
              </button>
            </header>

            <div className="bt-sheet-body">
              {inventoryLoading ? (
                <div className="bt-skel" />
              ) : inventory.data?.error ? (
                <div className="bt-error">{inventory.data.error}</div>
              ) : stockLocations.length === 0 ? (
                <div className="bt-warn-box">
                  None of this run&apos;s variants are stocked at an active
                  Shopify location with inventory tracking on, so there is
                  nothing to add to. Turn on inventory tracking for these
                  products first — nothing has been changed.
                </div>
              ) : (
                <>
                  {stockLocations.length > 1 && (
                    <div className="bt-field">
                      <label htmlFor="bt-loc">Location</label>
                      <select
                        id="bt-loc"
                        className="input"
                        value={locationId}
                        onChange={(e) => setLocationId(e.target.value)}
                      >
                        {stockLocations.map((l) => (
                          <option key={l.locationId} value={l.locationId}>
                            {l.locationName} — stocks {l.variantsStocked} of{" "}
                            {stockFor.products.reduce(
                              (n, p) => n + p.finishes.length,
                              0
                            )}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}

                  <div className="bt-tablewrap">
                    <table className="bt-table">
                      <thead>
                        <tr>
                          <th>Variant</th>
                          <th>Add</th>
                          <th>On hand</th>
                          <th>Available</th>
                        </tr>
                      </thead>
                      <tbody>
                        {/* One row per FINISH — that is the level Shopify
                            counts stock at, and the level the split decided. */}
                        {stockFor.products.flatMap((product) =>
                          product.finishes.map((finish) => {
                            const stock = stockVariants.find(
                              (s) => s.variantId === finish.variantId
                            );
                            const level = stock?.levels.find(
                              (l) => l.locationId === locationId
                            );
                            const skip = !stock?.tracked
                              ? "tracking off"
                              : !level
                                ? "not stocked here"
                                : null;

                            return (
                              <tr key={finish.id} data-skip={Boolean(skip)}>
                                <td>
                                  {product.productTitle}
                                  <span className="bt-td-sub">
                                    {finish.variantTitle}
                                  </span>
                                </td>
                                <td>
                                  {skip ? (
                                    <span className="bt-skip">{skip}</span>
                                  ) : (
                                    `+${finish.quantity}`
                                  )}
                                </td>
                                <td>
                                  {level ? (
                                    <>
                                      {level.onHand} →{" "}
                                      <b className="bt-after">
                                        {level.onHand + finish.quantity}
                                      </b>
                                    </>
                                  ) : (
                                    "—"
                                  )}
                                </td>
                                <td>
                                  {level ? (
                                    <>
                                      {level.available} →{" "}
                                      <b className="bt-after">
                                        {level.available + finish.quantity}
                                      </b>
                                    </>
                                  ) : (
                                    "—"
                                  )}
                                </td>
                              </tr>
                            );
                          })
                        )}
                      </tbody>
                    </table>
                  </div>

                  <p className="bt-inline-note">
                    Each variant&apos;s full planned quantity is added. Shopify
                    already holds the ordered pieces back as committed, so on
                    hand rises by the whole run while available rises only by
                    the surplus. Anything marked above is skipped, not silently
                    written.
                  </p>
                </>
              )}
            </div>

            <footer className="bt-sheet-foot">
              <button
                className="btn"
                onClick={() => setStockFor(null)}
                disabled={busy}
              >
                Cancel
              </button>
              <button
                className="btn btn-primary"
                disabled={busy || !canWriteInventory || !locationId}
                onClick={() =>
                  submit({ intent: "stock", batchId: stockFor.id, locationId })
                }
              >
                {busy ? "Writing…" : "Add to Shopify stock"}
              </button>
            </footer>
          </div>
        </div>
      )}
    </>
  );
}

// ─── Run card ─────────────────────────────────────────────────────────────

function BatchCard({
  batch,
  busy,
  canWriteInventory,
  expanded,
  onToggleExpand,
  onSubmit,
  onStock,
  onAddVariants,
  onPrint,
  onSplit,
}: {
  batch: BatchView;
  busy: boolean;
  canWriteInventory: boolean;
  expanded: Set<string>;
  onToggleExpand: (id: string) => void;
  onSubmit: (fields: Record<string, string | string[]>) => void;
  onStock: () => void;
  onAddVariants: () => void;
  onPrint: () => void;
  onSplit: (product: BatchProductView) => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(batch.name);
  const [confirmCancel, setConfirmCancel] = useState(false);

  const editable = batch.status === "OPEN";
  // The buttons must name the stage the run will ACTUALLY reach, so they read
  // from the same needed-stage set the server advances by. Otherwise a run of
  // silver pieces would offer "Plating →" and land on "Made".
  const needed = useMemo(() => new Set(batch.neededStages), [batch.neededStages]);
  const next = nextBatchStep(batch.stage, needed);
  const back = prevBatchStep(batch.stage, batch.status, needed);
  const stocked = Boolean(batch.inventorySyncedAt);

  const spreadText = batch.spread
    .filter(([, n]) => n > 0)
    .map(([col, n]) => `${n} at ${COLUMN_LABELS[col]}`)
    .join(" · ");

  return (
    <article className="bt-run" data-status={batch.status}>
      <div className="bt-run-top">
        <div className="bt-run-id">
          {renaming ? (
            <input
              className="input"
              maxLength={BATCH_NAME_MAX}
              // The field only exists because the merchant just clicked the
              // name to edit it — focus is where they asked for it.
              // eslint-disable-next-line jsx-a11y/no-autofocus
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onBlur={() => {
                setRenaming(false);
                if (name.trim() && name !== batch.name) {
                  onSubmit({ intent: "rename", batchId: batch.id, name });
                }
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur();
                if (e.key === "Escape") {
                  setName(batch.name);
                  setRenaming(false);
                }
              }}
            />
          ) : (
            <button
              type="button"
              className="bt-run-title"
              disabled={!editable}
              onClick={() => setRenaming(true)}
              title={editable ? "Rename this run" : undefined}
            >
              {batch.name}
            </button>
          )}
          <div className="bt-run-sub">
            {batch.products.length}{" "}
            {batch.products.length === 1 ? "product" : "products"} ·{" "}
            {batch.totalLines} order {batch.totalLines === 1 ? "line" : "lines"}
            {/* The soonest date anywhere in the run, from the tracker. It is
                what decides which run to push through the workshop next. */}
            {batch.earliestPromised && (
              <span className="bt-run-due">
                {" · due "}
                {formatPromisedDate(batch.earliestPromised)}
              </span>
            )}
          </div>
          {batch.note && <div className="bt-run-note">{batch.note}</div>}
        </div>

        <div className="bt-run-pos">
          <span className="bt-pill" data-status={batch.status}>
            {positionLabel(batch)}
          </span>
          <span className="bt-pill-sub">
            {BATCH_STATUS_LABELS[batch.status]}
          </span>
        </div>
      </div>

      {/* Run totals. Per-variant figures live on each row below.
          "Made" only appears once something has broken — with no scrap it is
          identical to planned, and a column that always repeats its neighbour
          is noise. */}
      <div className="bt-maths bt-maths-inline">
        <div>
          <b>{batch.plannedTotal}</b>
          <span>planned</span>
        </div>
        {batch.scrappedTotal > 0 && (
          <div className="bt-maths-scrap">
            <b>−{batch.scrappedTotal}</b>
            <span>lost</span>
          </div>
        )}
        {batch.scrappedTotal > 0 && (
          <div>
            <b>{batch.madeTotal}</b>
            <span>will exist</span>
          </div>
        )}
        <div>
          <b>{batch.committedTotal}</b>
          <span>committed</span>
        </div>
        <div className="bt-maths-surplus">
          <b>{batch.surplusTotal}</b>
          <span>surplus</span>
        </div>
      </div>

      {batch.shortfallTotal > 0 && (
        <div className="bt-error bt-error-inline">
          Short by {batch.shortfallTotal}{" "}
          {batch.shortfallTotal === 1 ? "piece" : "pieces"} — breakage has eaten
          past the surplus, so there are orders this run can no longer fill.
          {/* Raising the quantity only helps while nothing has been shaped
              yet. Past Casting the extra pieces would have to start from the
              beginning, which is a new run, not a bigger one. */}
          {batch.status === "OPEN" && !batch.stage
            ? " Raise a quantity below to make more."
            : " Split what survived, then start another run for the rest."}
        </div>
      )}

      {/* Stage strip. Stages nothing in this run needs are struck through —
          the run walks straight past them rather than stopping. */}
      {batch.status !== "CANCELLED" && (
        <div className="bt-stages">
          {STAGES.map((stage) => {
            const needed = batch.neededStages.includes(stage);
            return (
              <span
                key={stage}
                className="bt-stage"
                data-on={batch.stage === stage}
                data-skipped={!needed}
                title={needed ? undefined : "No piece in this run needs this stage"}
                data-done={
                  needed &&
                  (batch.status === "MADE" ||
                    (batch.stage
                      ? STAGES.indexOf(stage) < STAGES.indexOf(batch.stage)
                      : false))
                }
              >
                {STAGE_LABELS[stage]}
              </span>
            );
          })}
          <span className="bt-stage" data-on={batch.status === "MADE"}>
            Made
          </span>
        </div>
      )}

      {!batch.inStep && spreadText && (
        <div className="bt-warn-box bt-warn-inline">
          <span>Pieces have split up: {spreadText}.</span>
          <button
            className="bt-mini"
            disabled={busy}
            onClick={() => onSubmit({ intent: "pull", batchId: batch.id })}
          >
            Pull all to {positionLabel(batch)}
          </button>
        </div>
      )}

      {/* Products in the run */}
      <div className="bt-variants">
        {batch.products.map((product) => (
          <ProductRow
            key={product.id}
            batch={batch}
            product={product}
            busy={busy}
            editable={editable}
            expanded={expanded.has(product.id)}
            onToggleExpand={() => onToggleExpand(product.id)}
            onSubmit={onSubmit}
            onSplit={() => onSplit(product)}
          />
        ))}
      </div>

      {/* Actions */}
      <div className="bt-run-actions">
        {batch.status !== "CLOSED" && batch.status !== "CANCELLED" && (
          <>
            {back && (
              <button
                className="btn"
                disabled={busy}
                onClick={() => onSubmit({ intent: "revert", batchId: batch.id })}
              >
                ← {back.stage ? STAGE_LABELS[back.stage] : "Not started"}
              </button>
            )}
            {batch.status === "OPEN" && (
              <button
                className="btn btn-primary"
                disabled={busy}
                onClick={() => onSubmit({ intent: "advance", batchId: batch.id })}
              >
                {next.stage ? `${STAGE_LABELS[next.stage]} →` : "Mark made ✓"}
              </button>
            )}
          </>
        )}

        {batch.status === "MADE" && !stocked && (
          <button
            className="btn btn-primary"
            disabled={busy || !canWriteInventory}
            title={
              canWriteInventory
                ? undefined
                : "Needs re-authorisation with inventory permissions"
            }
            onClick={onStock}
          >
            Update Shopify stock
          </button>
        )}

        {editable && (
          <button className="btn" disabled={busy} onClick={onAddVariants}>
            <IconPlus /> Add products
          </button>
        )}

        {/* Available at every status, not just OPEN: an archived run's sheet
            is the record of what was made and who it went to. */}
        <button className="btn" onClick={onPrint} title="Print the run sheet">
          <IconPrinter /> Print
        </button>

        {batch.allClosed && batch.status !== "CLOSED" && (
          <button
            className="btn"
            disabled={busy}
            onClick={() => onSubmit({ intent: "archive", batchId: batch.id })}
          >
            Archive
          </button>
        )}

        {/* Two steps, because cancelling is irreversible and the run vanishes
            from the page — a mis-tap next to "Add variants" would otherwise
            destroy a plan with no way back. */}
        {editable &&
          (confirmCancel ? (
            <span className="bt-confirm">
              <span>
                Cancel this run? Its unfinished pieces go back to Untriaged.
              </span>
              <button
                className="btn bt-danger"
                disabled={busy}
                onClick={() => onSubmit({ intent: "cancel", batchId: batch.id })}
              >
                Yes, cancel
              </button>
              <button className="btn" onClick={() => setConfirmCancel(false)}>
                Keep it
              </button>
            </span>
          ) : (
            <button
              className="btn bt-danger"
              disabled={busy}
              onClick={() => setConfirmCancel(true)}
            >
              Cancel run
            </button>
          ))}
      </div>

      {stocked && (
        <p className="bt-receipt">
          <IconCheck /> Stock written
          {batch.inventoryLocation ? ` at ${batch.inventoryLocation}` : ""} ·{" "}
          {new Date(batch.inventorySyncedAt!).toLocaleString("en-GB", {
            day: "2-digit",
            month: "short",
            hour: "2-digit",
            minute: "2-digit",
          })}
        </p>
      )}

      {batch.totalLines > 0 && (
        <p className="bt-progress">
          {/* "Closed", not "shipped" — see toBatchView. A line also leaves the
              outstanding set when its order is cancelled or edited away, and
              claiming it shipped would be a guess dressed as a fact. */}
          {batch.closedLines} of {batch.totalLines} order lines closed
          {batch.closedLines > 0 ? " (shipped or cancelled)" : ""}
          {batch.changedLines > 0 && (
            <>
              {" · "}
              <b className="bt-changed">
                {batch.changedLines} changed since this run started
              </b>
            </>
          )}
        </p>
      )}
    </article>
  );
}

// ─── One variant inside a run ─────────────────────────────────────────────

function ProductRow({
  batch,
  product,
  busy,
  editable,
  expanded,
  onToggleExpand,
  onSubmit,
  onSplit,
}: {
  batch: BatchView;
  product: BatchProductView;
  busy: boolean;
  editable: boolean;
  expanded: boolean;
  onToggleExpand: () => void;
  onSubmit: (fields: Record<string, string | string[]>) => void;
  onSplit: () => void;
}) {
  const [editingQty, setEditingQty] = useState(false);
  const [qty, setQty] = useState(String(product.plannedQuantity));
  const [scrapQty, setScrapQty] = useState("");
  const [scrapNote, setScrapNote] = useState("");

  // Losses can be recorded right up until the stock write, because a flaw is
  // as likely to be found at final inspection as at the bench. After it, the
  // receipt is fixed and corrections belong in Shopify.
  const stocked = Boolean(batch.inventorySyncedAt);
  const splittable = product.finishes.length > 1 && !stocked;

  return (
    <div className="bt-variant">
      <div className="bt-variant-top">
        {shopifyImg(product.imageUrl, 100) ? (
          <img
            className="bt-thumb bt-thumb-sm"
            src={shopifyImg(product.imageUrl, 100)!}
            alt=""
            loading="lazy"
          />
        ) : (
          <div className="bt-thumb bt-thumb-sm bt-thumb-blank" />
        )}

        <div className="bt-variant-id">
          <div className="bt-variant-title">{product.productTitle}</div>
          <div className="bt-variant-sub">
            {/* The finishes, as decided so far. Before the split this is the
                seeded allocation; after it, the real one. */}
            {product.finishes
              .map((f) => `${f.quantity} ${f.variantTitle || "—"}`)
              .join(" · ") || "no finishes"}
          </div>
          <div className="bt-variant-where">
            {product.earliestPromised && (
              <span className="bt-variant-due">
                Due {formatPromisedDate(product.earliestPromised)} ·{" "}
              </span>
            )}
            {product.splitStage && product.finishes.length > 1
              ? `splits at ${STAGE_LABELS[product.splitStage]}`
              : "single finish"}
          </div>
        </div>

        <div className="bt-variant-nums">
          {editingQty ? (
            <input
              className="input bt-qty-input"
              type="number"
              min={product.committed}
              // eslint-disable-next-line jsx-a11y/no-autofocus
              autoFocus
              value={qty}
              onChange={(e) => setQty(e.target.value)}
              onBlur={() => {
                setEditingQty(false);
                if (Number(qty) !== product.plannedQuantity) {
                  onSubmit({
                    intent: "product-qty",
                    batchId: batch.id,
                    batchProductId: product.id,
                    plannedQuantity: qty,
                  });
                }
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur();
                if (e.key === "Escape") {
                  setQty(String(product.plannedQuantity));
                  setEditingQty(false);
                }
              }}
            />
          ) : editable ? (
            <button
              type="button"
              className="bt-variant-planned bt-editable"
              onClick={() => setEditingQty(true)}
              title="Change how many raw pieces the run makes"
            >
              {product.plannedQuantity}
            </button>
          ) : (
            <b className="bt-variant-planned">{product.plannedQuantity}</b>
          )}
          <span className="bt-variant-split">
            {product.scrapped > 0 && (
              <b className="bt-scrap-flag">−{product.scrapped} lost · </b>
            )}
            {product.committed} committed · {product.surplus} surplus
          </span>
        </div>

        <div className="bt-variant-acts">
          <button className="bt-mini" onClick={onToggleExpand}>
            {expanded ? "Hide" : `${product.lines.length} order${product.lines.length === 1 ? "" : "s"}`}
          </button>
          {editable && (
            <button
              className="bt-icon-btn"
              disabled={busy}
              aria-label={`Remove ${product.productTitle} from this run`}
              onClick={() =>
                onSubmit({
                  intent: "remove-product",
                  batchId: batch.id,
                  batchProductId: product.id,
                })
              }
            >
              <IconX size={14} />
            </button>
          )}
        </div>
      </div>

      {/* The split. Prompted when the run reaches the plating stage, and
          blocking the stock write until the numbers add up. */}
      {product.splitDue && (
        <div className="bt-warn-box bt-warn-inline">
          <span>
            The run has reached {STAGE_LABELS[product.splitStage ?? "PLATING"]}.
            Decide how many of the {product.made} pieces get each finish.
          </span>
          <button className="bt-mini" disabled={busy} onClick={onSplit}>
            Set finishes
          </button>
        </div>
      )}
      {!product.reconciled && !product.splitDue && (
        <div className="bt-error bt-error-inline">
          {product.made} {product.made === 1 ? "piece" : "pieces"} will exist but{" "}
          {product.allocated} allocated across finishes.{" "}
          {splittable ? "Adjust the split before writing stock." : ""}
          {splittable && (
            <button className="bt-mini" disabled={busy} onClick={onSplit}>
              Fix the split
            </button>
          )}
        </div>
      )}

      {product.shortfall > 0 ? (
        <p className="bt-inline-warn">
          {product.shortfall} short: {product.committed} owed but only{" "}
          {product.made} will exist after breakage.
        </p>
      ) : null}

      {product.unclaimedLines > 0 && editable && (
        <div className="bt-warn-box bt-warn-inline">
          <span>
            {product.unclaimedPieces} more{" "}
            {product.unclaimedPieces === 1 ? "piece" : "pieces"} ordered since
            this run started.
          </span>
          <button
            className="bt-mini"
            disabled={busy}
            onClick={() =>
              onSubmit({
                intent: "add-lines",
                batchId: batch.id,
                batchProductId: product.id,
              })
            }
          >
            Add to run
          </button>
        </div>
      )}

      {expanded && (
        <div className="bt-variant-detail">
          {/* Finishes, with each one's remaining path. The route is a property
              of the variant, not this run, so editing it here changes it for
              every future run too — which is the point. */}
          <div className="bt-detail-block">
            <div className="bt-detail-head">
              Finishes
              {splittable && (
                <button className="bt-mini" disabled={busy} onClick={onSplit}>
                  Change split
                </button>
              )}
            </div>
            {product.finishes.map((finish) => (
              <div key={finish.id} className="bt-finish">
                <span className="bt-finish-name">
                  {finish.variantTitle || "—"}
                  {finish.sku ? <span className="bt-sub"> · {finish.sku}</span> : null}
                </span>
                <span className="bt-finish-qty">{finish.quantity}</span>
                <span className="bt-finish-state">
                  {finish.committed > 0 ? `${finish.committed} on order · ` : ""}
                  {finish.doneAtSplit
                    ? "no further stages"
                    : finish.remainingStages
                        .map((s) => STAGE_LABELS[s])
                        .join(" → ")}
                </span>
                {finish.inventoryDelta !== null && (
                  <span className="bt-finish-done">
                    <IconCheck size={11} /> +{finish.inventoryDelta}
                  </span>
                )}
              </div>
            ))}
          </div>

          {/* A finish's permanent route through the workshop. */}
          <div className="bt-detail-block">
            <div className="bt-detail-head">
              Stages each finish goes through — remembered for future runs
            </div>
            {product.finishes.map((finish) => (
              <div key={finish.id} className="bt-routerow">
                <span className="bt-route-name">{finish.variantTitle || "—"}</span>
                <span className="bt-pathchips">
                  {STAGES.map((stage) => {
                    const on = !finish.doneAtSplit
                      ? finish.remainingStages.includes(stage) ||
                        (product.splitStage !== null &&
                          STAGES.indexOf(stage) <
                            STAGES.indexOf(product.splitStage))
                      : product.splitStage !== null &&
                        STAGES.indexOf(stage) <
                          STAGES.indexOf(product.splitStage);
                    return (
                      <button
                        key={stage}
                        className={on ? "bt-pathchip on" : "bt-pathchip"}
                        disabled={busy}
                        title={
                          on
                            ? `${finish.variantTitle || "This finish"} skips ${STAGE_LABELS[stage]} from now on`
                            : `Include ${STAGE_LABELS[stage]}`
                        }
                        onClick={() => {
                          const skip = STAGES.filter((s) =>
                            s === stage
                              ? on
                              : !(
                                  finish.remainingStages.includes(s) ||
                                  (product.splitStage !== null &&
                                    STAGES.indexOf(s) <
                                      STAGES.indexOf(product.splitStage))
                                )
                          );
                          onSubmit({
                            intent: "route",
                            batchId: batch.id,
                            productId: product.productId,
                            variantId: finish.variantId,
                            skipStage: skip,
                          });
                        }}
                      >
                        {STAGE_LABELS[stage].slice(0, 3)}
                      </button>
                    );
                  })}
                </span>
              </div>
            ))}
          </div>

          {/* Losses. Recorded against the PRODUCT — a piece that cracks at
              casting is a raw piece with no finish to name. */}
          <div className="bt-detail-block">
            <div className="bt-detail-head">
              Pieces lost
              {product.scrapped > 0 && (
                <span className="bt-scrap-flag"> {product.scrapped}</span>
              )}
            </div>
            {product.scraps.map((scrap) => (
              <div key={scrap.id} className="bt-scrap-row">
                <span className="bt-scrap-n">−{scrap.quantity}</span>
                <span className="bt-scrap-where">
                  {scrap.stage && isStage(scrap.stage)
                    ? STAGE_LABELS[scrap.stage]
                    : "before the run started"}
                  {scrap.note ? ` · ${scrap.note}` : ""}
                </span>
                <span className="bt-scrap-when">
                  {new Date(scrap.createdAt).toLocaleDateString("en-GB", {
                    day: "2-digit",
                    month: "short",
                  })}
                </span>
                {!stocked && (
                  <button
                    className="bt-icon-btn"
                    disabled={busy}
                    aria-label="Remove this loss"
                    onClick={() =>
                      onSubmit({
                        intent: "unscrap",
                        batchId: batch.id,
                        scrapId: scrap.id,
                      })
                    }
                  >
                    <IconX size={13} />
                  </button>
                )}
              </div>
            ))}

            {stocked ? (
              <p className="bt-inline-note">
                Stock is written — record any further losses in Shopify.
              </p>
            ) : (
              <div className="bt-scrap-form">
                <label className="bt-sr" htmlFor={`scrap-n-${product.id}`}>
                  Pieces lost
                </label>
                <input
                  id={`scrap-n-${product.id}`}
                  className="input bt-qty-input"
                  type="number"
                  min={1}
                  max={product.made}
                  inputMode="numeric"
                  placeholder="0"
                  value={scrapQty}
                  onChange={(e) => setScrapQty(e.target.value)}
                />
                <label className="bt-sr" htmlFor={`scrap-note-${product.id}`}>
                  What happened
                </label>
                <input
                  id={`scrap-note-${product.id}`}
                  className="input"
                  maxLength={SCRAP_NOTE_MAX}
                  placeholder="Cracked stone, failed casting…"
                  value={scrapNote}
                  onChange={(e) => setScrapNote(e.target.value)}
                />
                <button
                  className="bt-mini"
                  disabled={busy || !scrapQty || Number(scrapQty) <= 0}
                  onClick={() => {
                    onSubmit({
                      intent: "scrap",
                      batchId: batch.id,
                      batchProductId: product.id,
                      quantity: scrapQty,
                      note: scrapNote,
                    });
                    setScrapQty("");
                    setScrapNote("");
                  }}
                >
                  Record loss
                </button>
              </div>
            )}
          </div>

          <div className="bt-detail-head">Orders</div>
          {product.lines.length === 0 ? (
            <p className="bt-lines-empty">
              No orders — every piece of this product becomes stock.
            </p>
          ) : (
            <div className="bt-lines">
              {product.lines.map((line) => (
                <div key={line.lineItemId} className="bt-line">
                  <span className="bt-line-order">{line.orderName}</span>
                  <span className="bt-line-qty">
                    ×{line.liveQuantity ?? line.snapshotQuantity}
                    {line.changed && (
                      <b className="bt-changed"> was ×{line.snapshotQuantity}</b>
                    )}
                  </span>
                  <span className="bt-line-state">
                    {line.variantTitle ? `${line.variantTitle} · ` : ""}
                    {line.liveQuantity === null
                      ? "No longer outstanding"
                      : line.column
                        ? COLUMN_LABELS[line.column]
                        : "—"}
                  </span>
                  <span className="bt-line-due">
                    {formatPromisedDate(line.promisedDate) ?? ""}
                  </span>
                  {editable && line.liveQuantity !== null && (
                    <button
                      className="bt-icon-btn"
                      disabled={busy}
                      aria-label={`Remove ${line.orderName}`}
                      onClick={() =>
                        onSubmit({
                          intent: "remove-line",
                          batchId: batch.id,
                          lineItemId: line.lineItemId,
                        })
                      }
                    >
                      <IconX size={13} />
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}


// ─── Styles ───────────────────────────────────────────────────────────────

const BATCH_CSS = `
@import url('https://fonts.googleapis.com/css2?family=Archivo:wght@400;600;800&display=swap');

/* The design tokens are declared on BOTH roots, not just .bt-app.
   The overlays are rendered as siblings of .bt-app rather than children —
   a dialog must not be trapped inside a container that sets overflow — so
   custom properties scoped to .bt-app alone don't reach them. Every var()
   inside the sheet then resolves to nothing at computed-value time, which
   silently unsets the whole declaration: no panel background, no borders,
   just floating text over the page. Declaring the tokens here as well is
   what keeps the two surfaces sharing one palette. */
.bt-app, .bt-overlay {
  --color-bg: #f3f2f2;
  --color-surface: #eae9e9;
  --color-text: #201e1d;
  --color-accent: #ec3013;
  --color-divider: color-mix(in srgb, #201e1d 40%, transparent);
  --color-neutral-600: #7d7979;
  --font-heading: "Archivo", system-ui, sans-serif;
}

.bt-app {
  background: var(--color-bg);
  color: var(--color-text);
  font-family: "Archivo", system-ui, sans-serif;
  font-size: 15px;
  line-height: 1.55;
  min-height: 100vh;
  /* One over-wide child would stretch the mobile viewport and stop every
     breakpoint below from matching — the pick list learned this the hard way. */
  max-width: 100%;
  overflow-x: hidden;
}
.bt-app *, .bt-app *::before, .bt-app *::after { box-sizing: border-box; }
.bt-app img { max-width: 100%; }

.bt-page { max-width: 1100px; margin: 0 auto; padding: 30px 24px 80px; }

/* The print source. Only its markup is copied into the new tab, so this never
   needs to be visible — but it is positioned off-screen rather than hidden
   with display:none so the browser still lays it out and starts fetching the
   images. The new tab then loads them from cache instead of over the network,
   which matters because it waits for the load event before opening the print
   dialog. (No backticks in here — this whole block is a template literal.) */
.bt-printsrc {
  position: absolute; left: -10000px; top: 0; width: 800px;
  pointer-events: none;
}

.bt-header {
  display: flex; align-items: flex-end; justify-content: space-between;
  gap: 16px; padding-bottom: 18px; border-bottom: 2px solid var(--color-divider);
}
.bt-eyebrow {
  font-family: var(--font-heading); font-weight: 800; font-size: 11px;
  letter-spacing: .12em; text-transform: uppercase; color: var(--color-accent);
  margin: 0 0 6px;
}
.bt-header h1 {
  font-family: var(--font-heading); font-weight: 800; font-size: 44px;
  letter-spacing: -.02em; line-height: 1; margin: 0;
}
.bt-head-actions { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.bt-freshness { font-size: 11px; color: var(--color-neutral-600); white-space: nowrap; }
.bt-saving {
  font-family: var(--font-heading); font-weight: 800; font-size: 11px;
  letter-spacing: .08em; text-transform: uppercase; color: var(--color-accent);
  animation: btPulse 1.1s ease-in-out infinite;
}
@keyframes btPulse { 0%,100% { opacity: .45; } 50% { opacity: 1; } }

.bt-app .btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 7px;
  font-family: var(--font-heading); font-weight: 800; font-size: 13px;
  padding: 10px 16px; border-radius: 0; border: 1px solid var(--color-divider);
  background: transparent; color: var(--color-text); cursor: pointer;
}
.bt-app .btn:hover:not(:disabled) {
  background: color-mix(in srgb, var(--color-text) 7%, transparent);
}
.bt-app .btn:disabled { opacity: .5; cursor: default; }
.bt-app .btn-primary {
  background: var(--color-text); color: var(--color-bg); border-color: var(--color-text);
}
.bt-app .btn-primary:hover:not(:disabled) { background: #000; }
.bt-app .bt-danger { color: var(--color-accent); }

.bt-app .input {
  width: 100%; min-height: 40px; padding: 8px 12px; font: inherit; font-size: 14px;
  color: var(--color-text); background: var(--color-surface);
  border: 1px solid var(--color-divider); border-radius: 0;
}
.bt-app .input:focus-visible { border-color: var(--color-accent); outline: none; }

.bt-stats { display: flex; flex-wrap: wrap; border-bottom: 2px solid var(--color-divider); }
.bt-stats > div {
  flex: 1 1 120px; padding: 18px 20px; border-right: 1px solid var(--color-divider);
}
.bt-stats > div.bt-stat-last { border-right: none; }
.bt-stat-n { font-family: var(--font-heading); font-weight: 800; font-size: 34px; line-height: 1; }
.bt-stat-n.bt-accent { color: var(--color-accent); }
.bt-stat-l {
  font-size: 11px; letter-spacing: .1em; text-transform: uppercase;
  color: var(--color-neutral-600); margin-top: 6px;
}
.bt-stat-sub {
  font-family: var(--font-heading); font-weight: 800; font-size: 11px;
  color: var(--color-text); margin-top: 3px;
}

.bt-legend { font-size: 11px; color: var(--color-neutral-600); padding: 10px 0 0; margin: 0; }
.bt-legend b { font-family: var(--font-heading); color: var(--color-text); }

.bt-toolbar { padding: 18px 0; }

.bt-error {
  border: 1px solid var(--color-accent); background: #fff2ef;
  color: #7c1405; padding: 12px 14px; font-size: 14px; margin-bottom: 16px;
}
.bt-notice {
  border: 1px solid #1c6b3a; background: #eefaf1;
  color: #14522c; padding: 12px 14px; font-size: 14px; margin-bottom: 16px;
}
.bt-warn-box {
  border: 1px solid #b8860b; background: #fdf6e3;
  color: #6b4e00; padding: 11px 13px; font-size: 13px; margin-bottom: 16px;
}
/* Orders a run can already fill. Distinct from the warning boxes — this is an
   opportunity, not a problem, and it should not read like one. */
.bt-suggest {
  border: 1px solid #1c6b3a; background: #eefaf1; color: #14522c;
  padding: 11px 13px; margin-bottom: 16px;
}
.bt-suggest-head {
  display: flex; align-items: center; justify-content: space-between;
  gap: 12px; flex-wrap: wrap; font-size: 13px;
}
.bt-suggest-acts { display: flex; align-items: center; gap: 8px; }
.bt-suggest-list {
  margin-top: 10px; border-top: 1px solid color-mix(in srgb, #1c6b3a 30%, transparent);
}
.bt-suggest-row {
  display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 10px;
  padding: 6px 0; font-size: 12px;
  border-bottom: 1px solid color-mix(in srgb, #1c6b3a 18%, transparent);
}
.bt-suggest-row:last-child { border-bottom: none; }
.bt-suggest-order { font-family: var(--font-heading); font-weight: 800; min-width: 56px; }
.bt-suggest-what { flex: 1 1 auto; }
.bt-suggest-to { font-family: var(--font-heading); font-weight: 800; }

.bt-warn-inline {
  display: flex; align-items: center; justify-content: space-between;
  gap: 12px; flex-wrap: wrap; margin: 10px 0 0;
}

.bt-section { padding-top: 34px; }
.bt-section h2 {
  font-family: var(--font-heading); font-weight: 800; font-size: 13px;
  letter-spacing: .12em; text-transform: uppercase; margin: 0 0 4px;
  display: flex; align-items: center; gap: 10px;
}
.bt-count {
  font-size: 11px; background: var(--color-text); color: var(--color-bg);
  padding: 1px 7px; letter-spacing: 0;
}

/* ── Runs ─────────────────────────────────────────────────────────────── */

.bt-runs { display: flex; flex-direction: column; gap: 14px; padding-top: 14px; }
.bt-run {
  border: 1px solid var(--color-divider); background: var(--color-surface);
  padding: 16px;
}
.bt-run[data-status="MADE"] { border-left: 4px solid #1c6b3a; }
.bt-run[data-status="CLOSED"] { opacity: .72; }

.bt-run-top { display: flex; gap: 14px; align-items: flex-start; }
.bt-run-id { flex: 1 1 auto; min-width: 0; }
.bt-run-title {
  font-family: var(--font-heading); font-weight: 800; font-size: 18px;
  line-height: 1.25; background: transparent; border: none; padding: 0;
  color: inherit; cursor: pointer; text-align: left;
}
.bt-run-title:disabled { cursor: default; }
.bt-run-title:hover:not(:disabled) { text-decoration: underline dotted; text-underline-offset: 4px; }
.bt-run-sub { font-size: 12px; color: var(--color-neutral-600); }
.bt-run-note { font-size: 12px; margin-top: 4px; font-style: italic; }
.bt-run-pos { text-align: right; flex: none; }
.bt-pill {
  display: inline-block; font-family: var(--font-heading); font-weight: 800;
  font-size: 11px; letter-spacing: .08em; text-transform: uppercase;
  padding: 4px 9px; background: var(--color-text); color: var(--color-bg);
}
.bt-pill[data-status="MADE"] { background: #1c6b3a; }
.bt-pill[data-status="CANCELLED"] { background: var(--color-neutral-600); }
.bt-pill-sub {
  display: block; font-size: 10px; color: var(--color-neutral-600); margin-top: 4px;
}

.bt-thumb {
  width: 54px; height: 54px; object-fit: cover; flex: none;
  border: 1px solid var(--color-divider); background: #fff;
}
.bt-thumb-sm { width: 38px; height: 38px; }
.bt-thumb-blank { background: var(--color-bg); }

.bt-maths { display: flex; margin: 14px 0 0; border: 1px solid var(--color-divider); }
.bt-maths > div {
  flex: 1 1 0; padding: 10px 12px; text-align: center;
  border-right: 1px solid var(--color-divider);
}
.bt-maths > div:last-child { border-right: none; }
.bt-maths b {
  display: block; font-family: var(--font-heading); font-weight: 800;
  font-size: 24px; line-height: 1.1;
}
.bt-maths span {
  font-size: 10px; letter-spacing: .08em; text-transform: uppercase;
  color: var(--color-neutral-600);
}
.bt-maths-surplus b { color: var(--color-accent); }
.bt-maths-inline { background: var(--color-bg); }

.bt-inline-warn { font-size: 12px; color: #7c1405; margin: 8px 0 0; }
.bt-inline-note { font-size: 12px; color: var(--color-neutral-600); margin: 10px 0 0; }

.bt-stages { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 14px; }
.bt-stage {
  font-family: var(--font-heading); font-weight: 800; font-size: 10px;
  letter-spacing: .06em; text-transform: uppercase; padding: 4px 8px;
  border: 1px solid var(--color-divider); color: var(--color-neutral-600);
}
.bt-stage[data-done="true"] { color: var(--color-text); border-color: var(--color-text); }
.bt-stage[data-on="true"] {
  background: var(--color-accent); border-color: var(--color-accent); color: #fff;
}
/* A stage nothing in the run needs. The run walks straight past it. */
.bt-stage[data-skipped="true"] {
  text-decoration: line-through; opacity: .45;
  border-style: dashed; background: transparent;
}

/* ── Per-variant detail: stage path and losses ───────────────────────────── */

.bt-variant-where { font-size: 11px; color: var(--color-neutral-600); margin-top: 2px; }
/* Promised dates come from the tracker and are the reason to push one run or
   one piece ahead of another, so they carry the accent rather than blending
   into the grey metadata beside them. */
.bt-variant-due, .bt-run-due {
  color: var(--color-accent); font-family: var(--font-heading); font-weight: 800;
}
.bt-done-early {
  display: inline-flex; align-items: center; gap: 4px; color: #1c6b3a;
  font-family: var(--font-heading); font-weight: 800;
}
.bt-skips { font-style: italic; }
.bt-scrap-flag { color: var(--color-accent); font-family: var(--font-heading); font-weight: 800; }
.bt-maths-scrap b { color: var(--color-accent); }
.bt-error-inline { margin: 12px 0 0; }

.bt-variant-detail { margin-top: 12px; border-top: 1px solid var(--color-divider); }
.bt-detail-block { padding: 10px 0; border-bottom: 1px solid
  color-mix(in srgb, var(--color-divider) 40%, transparent); }
.bt-detail-head {
  font-size: 10px; letter-spacing: .08em; text-transform: uppercase;
  color: var(--color-neutral-600); margin: 10px 0 6px;
  font-family: var(--font-heading); font-weight: 800;
}
.bt-pathchips { display: flex; flex-wrap: wrap; gap: 4px; }
.bt-pathchip {
  font-family: var(--font-heading); font-weight: 800; font-size: 10px;
  letter-spacing: .06em; text-transform: uppercase; padding: 5px 9px;
  border: 1px dashed var(--color-divider); background: transparent;
  color: var(--color-neutral-600); cursor: pointer;
  text-decoration: line-through;
}
.bt-pathchip.on {
  border-style: solid; border-color: var(--color-text); color: var(--color-text);
  text-decoration: none;
}
.bt-pathchip:disabled { cursor: default; opacity: .6; }

/* Finishes within a product, and their remembered routes. */
.bt-finish {
  display: flex; align-items: baseline; gap: 8px; font-size: 12px; padding: 4px 0;
}
.bt-finish-name { font-family: var(--font-heading); font-weight: 800; min-width: 90px; }
.bt-finish-qty {
  font-family: var(--font-heading); font-weight: 800; font-size: 15px; min-width: 26px;
}
.bt-finish-state { flex: 1 1 auto; color: var(--color-neutral-600); }
.bt-finish-done {
  display: inline-flex; align-items: center; gap: 3px; color: #1c6b3a;
  font-family: var(--font-heading); font-weight: 800;
}
.bt-routerow { display: flex; align-items: center; gap: 8px; padding: 4px 0; flex-wrap: wrap; }
.bt-route-name {
  font-family: var(--font-heading); font-weight: 800; font-size: 12px; min-width: 90px;
}

.bt-scrap-row {
  display: flex; align-items: center; gap: 8px; font-size: 12px; padding: 4px 0;
}
.bt-scrap-n {
  font-family: var(--font-heading); font-weight: 800; color: var(--color-accent);
  min-width: 30px;
}
.bt-scrap-where { flex: 1 1 auto; color: var(--color-neutral-600); }
.bt-scrap-when { font-size: 11px; color: var(--color-neutral-600); }
.bt-scrap-form { display: flex; gap: 6px; align-items: center; margin-top: 8px; }
.bt-scrap-form .input { min-height: 34px; font-size: 13px; }
.bt-scrap-form .bt-qty-input { flex: none; }

/* ── Variants inside a run ────────────────────────────────────────────── */

.bt-variants {
  margin-top: 14px; border: 1px solid var(--color-divider); background: var(--color-bg);
}
.bt-variant { border-bottom: 1px solid var(--color-divider); padding: 10px 12px; }
.bt-variant:last-child { border-bottom: none; }
.bt-variant-top { display: flex; align-items: center; gap: 12px; }
.bt-variant-id { flex: 1 1 auto; min-width: 0; }
.bt-variant-title {
  font-family: var(--font-heading); font-weight: 800; font-size: 14px; line-height: 1.3;
}
.bt-variant-sub { font-size: 12px; color: var(--color-neutral-600); }
.bt-variant-nums { text-align: right; flex: none; }
.bt-variant-planned {
  display: block; font-family: var(--font-heading); font-weight: 800;
  font-size: 20px; line-height: 1; background: transparent; border: none;
  padding: 0; color: inherit; margin-left: auto;
}
.bt-variant-nums .bt-editable {
  cursor: pointer; text-decoration: underline dotted; text-underline-offset: 3px;
}
.bt-variant-split { font-size: 10px; color: var(--color-neutral-600); white-space: nowrap; }
.bt-variant-acts { display: flex; align-items: center; gap: 4px; flex: none; }

.bt-run-actions {
  display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-top: 14px;
}
.bt-mini {
  font-family: var(--font-heading); font-weight: 800; font-size: 11px;
  padding: 7px 10px; border: 1px solid var(--color-divider);
  background: transparent; color: var(--color-text); cursor: pointer;
}
.bt-mini:disabled { opacity: .5; cursor: default; }
.bt-confirm {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  border: 1px solid var(--color-accent); background: #fff2ef;
  padding: 6px 6px 6px 12px;
}
.bt-confirm > span { font-size: 12px; color: #7c1405; }

.bt-receipt {
  display: flex; align-items: center; gap: 6px; font-size: 12px; color: #14522c;
  margin: 12px 0 0; font-family: var(--font-heading); font-weight: 800;
}
.bt-progress { font-size: 12px; color: var(--color-neutral-600); margin: 8px 0 0; }

.bt-lines { margin-top: 10px; border-top: 1px solid var(--color-divider); }
.bt-line {
  display: flex; align-items: center; gap: 10px; padding: 7px 0;
  border-bottom: 1px solid color-mix(in srgb, var(--color-divider) 50%, transparent);
  font-size: 13px;
}
.bt-line:last-child { border-bottom: none; }
.bt-line-order { font-family: var(--font-heading); font-weight: 800; min-width: 62px; }
.bt-line-qty { color: var(--color-neutral-600); min-width: 32px; }
.bt-line-state { flex: 1 1 auto; color: var(--color-neutral-600); }
.bt-line-due { font-size: 12px; color: var(--color-neutral-600); }
/* An order edited after the run started — worth noticing, not alarming. */
.bt-changed { color: #6b4e00; font-family: var(--font-heading); font-weight: 800; }
.bt-lines-empty { font-size: 13px; color: var(--color-neutral-600); padding: 10px 0; margin: 0; }

.bt-icon-btn {
  display: inline-flex; align-items: center; justify-content: center;
  width: 28px; height: 28px; border: 1px solid transparent; background: transparent;
  color: var(--color-text); cursor: pointer; flex: none;
}
.bt-icon-btn:hover { border-color: var(--color-divider); }
.bt-icon-btn:disabled { opacity: .5; cursor: default; }

/* ── Candidates ───────────────────────────────────────────────────────── */

.bt-cands { display: flex; flex-direction: column; gap: 8px; padding-top: 14px; }
.bt-cand {
  display: flex; align-items: center; gap: 14px; width: 100%; text-align: left;
  padding: 12px; border: 1px solid var(--color-divider); background: var(--color-surface);
  cursor: pointer; font: inherit; color: inherit;
}
.bt-cand:hover { border-color: var(--color-text); }
.bt-cand-main { flex: 1 1 auto; min-width: 0; }
.bt-cand-title { font-family: var(--font-heading); font-weight: 800; font-size: 15px; }
.bt-cand-sub { font-size: 12px; color: var(--color-neutral-600); }
.bt-cand-due { font-size: 11px; color: var(--color-accent); margin-top: 2px; }
.bt-cand-nums { text-align: right; flex: none; }
.bt-cand-nums b {
  display: block; font-family: var(--font-heading); font-weight: 800; font-size: 22px;
  line-height: 1;
}
.bt-cand-nums span { display: block; font-size: 10px; color: var(--color-neutral-600); }
.bt-cand-ready { color: #1c6b3a !important; font-weight: 800; }
.bt-cand-go {
  display: inline-flex; align-items: center; gap: 5px; flex: none;
  font-family: var(--font-heading); font-weight: 800; font-size: 12px;
  padding: 8px 12px; border: 1px solid var(--color-text);
}

.bt-archive-toggle {
  font-family: var(--font-heading); font-weight: 800; font-size: 12px;
  padding: 9px 12px; border: 1px solid var(--color-divider);
  background: transparent; color: var(--color-text); cursor: pointer;
}

.bt-empty {
  display: flex; flex-direction: column; align-items: center; gap: 12px;
  padding: 40px 20px; color: var(--color-neutral-600); text-align: center;
}
.bt-empty p { margin: 0; font-size: 14px; }
.bt-skel-list { display: flex; flex-direction: column; gap: 10px; padding-top: 14px; }
.bt-skel {
  height: 72px; background: linear-gradient(90deg,
    var(--color-surface) 25%, #e0dedd 37%, var(--color-surface) 63%);
  background-size: 400% 100%; animation: btShimmer 1.4s ease infinite;
}
@keyframes btShimmer { 0% { background-position: 100% 0; } 100% { background-position: 0 0; } }

/* ── Overlays ─────────────────────────────────────────────────────────── */

.bt-overlay {
  position: fixed; inset: 0; z-index: 900;
  /* Literal rgba rather than a token or color-mix: this is the one rule that
     must render even if everything else about the palette fails, because an
     un-dimmed backdrop makes a transparent-looking dialog unreadable. */
  background: rgba(0, 0, 0, .45);
  display: flex; align-items: center; justify-content: center; padding: 20px;
}
.bt-overlay, .bt-overlay *, .bt-overlay *::before, .bt-overlay *::after {
  box-sizing: border-box;
}
/* Click-outside-to-dismiss, as a focusable element rather than a handler on
   the backdrop — see the comment at its JSX. */
.bt-backdrop {
  position: absolute; inset: 0; width: 100%; height: 100%;
  border: none; background: transparent; cursor: default; padding: 0;
}
.bt-sheet {
  position: relative; z-index: 901;
  background: #f3f2f2; color: #201e1d; border: 1px solid #201e1d;
  box-shadow: 0 12px 32px rgba(45, 43, 43, .3);
  width: 100%; max-width: 520px; max-height: 88vh; display: flex; flex-direction: column;
  font-family: "Archivo", system-ui, sans-serif;
}
.bt-sheet-wide { max-width: 680px; }
.bt-sheet-head {
  display: flex; align-items: flex-start; justify-content: space-between; gap: 12px;
  padding: 16px; border-bottom: 2px solid var(--color-divider);
}
.bt-sheet-title { font-family: var(--font-heading); font-weight: 800; font-size: 17px; line-height: 1.25; }
.bt-sheet-sub { font-size: 13px; color: var(--color-neutral-600); }
.bt-sheet-body { padding: 16px; overflow-y: auto; flex: 1 1 auto; }
.bt-sheet-foot {
  display: flex; gap: 10px; justify-content: flex-end; padding: 14px 16px;
  border-top: 1px solid var(--color-divider);
}
.bt-sheet .btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 7px;
  font-family: var(--font-heading); font-weight: 800; font-size: 13px;
  padding: 10px 16px; border: 1px solid var(--color-divider);
  background: transparent; color: var(--color-text); cursor: pointer; border-radius: 0;
}
.bt-sheet .btn-primary {
  background: var(--color-text); color: var(--color-bg); border-color: var(--color-text);
}
.bt-sheet .btn:disabled { opacity: .5; cursor: default; }
.bt-sheet .input {
  width: 100%; min-height: 40px; padding: 8px 12px; font: inherit; font-size: 14px;
  color: var(--color-text); background: var(--color-surface);
  border: 1px solid var(--color-divider); border-radius: 0;
}
.bt-sheet .bt-maths { background: var(--color-surface); }
/* Totals stay visible while scrolling a long variant list — the arithmetic is
   the whole reason for the dialog. */
.bt-maths-sticky { position: sticky; top: 0; z-index: 2; background: #f3f2f2 !important; }

.bt-field { margin-bottom: 14px; }
.bt-field-top { margin-top: 16px; }
.bt-field label {
  display: block; font-size: 11px; letter-spacing: .08em; text-transform: uppercase;
  color: var(--color-neutral-600); margin-bottom: 5px;
}
.bt-sr {
  position: absolute; width: 1px; height: 1px; overflow: hidden;
  clip: rect(0 0 0 0); white-space: nowrap;
}

/* Source tabs — outstanding work vs the whole catalogue. */
.bt-tabs { display: flex; gap: 0; margin: 18px 0 12px; }
.bt-tab {
  flex: 1 1 0; font-family: var(--font-heading); font-weight: 800; font-size: 12px;
  padding: 9px 10px; border: 1px solid var(--color-divider);
  background: transparent; color: var(--color-neutral-600); cursor: pointer;
}
.bt-tab + .bt-tab { border-left: none; }
.bt-tab.on {
  background: var(--color-text); border-color: var(--color-text); color: var(--color-bg);
}

/* What is already in the run, kept visible while picking from either source. */
.bt-chosen {
  border: 1px solid var(--color-text); margin-top: 16px; background: var(--color-surface);
}
.bt-chosen-head {
  display: flex; align-items: center; justify-content: space-between; gap: 10px;
  padding: 8px 10px; border-bottom: 1px solid var(--color-divider);
  font-size: 11px; letter-spacing: .08em; text-transform: uppercase;
  color: var(--color-neutral-600);
}
.bt-chosen-row {
  display: flex; align-items: center; gap: 10px; padding: 8px 10px;
  border-bottom: 1px solid color-mix(in srgb, var(--color-divider) 45%, transparent);
}
.bt-chosen-row:last-child { border-bottom: none; }
.bt-chosen-row .bt-pick-text { flex: 1 1 auto; min-width: 0; }

.bt-picker {
  border: 1px solid var(--color-divider); max-height: 300px; overflow-y: auto;
  margin-top: 4px;
}
.bt-pickrow {
  display: flex; align-items: center; gap: 8px; padding-right: 10px;
  border-bottom: 1px solid color-mix(in srgb, var(--color-divider) 45%, transparent);
}
.bt-pickrow:last-child { border-bottom: none; }
.bt-pickrow.on { background: color-mix(in srgb, var(--color-accent) 8%, transparent); }
.bt-pickmain {
  display: flex; align-items: center; gap: 10px; flex: 1 1 auto; min-width: 0;
  text-align: left; padding: 9px 11px; background: transparent; border: none;
  cursor: pointer; font: inherit; font-size: 13px; color: inherit;
}
.bt-pick-box {
  width: 18px; height: 18px; border: 1px solid var(--color-text); flex: none;
  display: inline-flex; align-items: center; justify-content: center;
}
.bt-pickrow.on .bt-pick-box { background: var(--color-text); color: var(--color-bg); }
.bt-pick-text { min-width: 0; }
.bt-pick-title {
  display: block; font-family: var(--font-heading); font-weight: 800;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.bt-pick-sub { display: block; font-size: 11px; color: var(--color-neutral-600); }
.bt-qtycell { flex: none; }
.bt-qty-input { max-width: 82px; text-align: center; }

.bt-tablewrap { overflow-x: auto; }
.bt-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.bt-table th {
  font-family: var(--font-heading); font-weight: 800; font-size: 10px;
  letter-spacing: .08em; text-transform: uppercase; color: var(--color-neutral-600);
  text-align: right; padding: 6px 8px; border-bottom: 1px solid var(--color-divider);
  white-space: nowrap;
}
.bt-table th:first-child { text-align: left; }
.bt-table td {
  padding: 8px; text-align: right; white-space: nowrap;
  border-bottom: 1px solid color-mix(in srgb, var(--color-divider) 45%, transparent);
}
.bt-table td:first-child {
  text-align: left; white-space: normal;
  font-family: var(--font-heading); font-weight: 800;
}
.bt-table tr[data-skip="true"] { opacity: .55; }
.bt-td-sub {
  display: block; font-family: "Archivo", system-ui, sans-serif; font-weight: 400;
  font-size: 11px; color: var(--color-neutral-600);
}
.bt-after { font-family: var(--font-heading); font-weight: 800; color: var(--color-accent); }
.bt-skip {
  font-size: 10px; letter-spacing: .06em; text-transform: uppercase;
  color: #6b4e00;
}

/* ── Small screens ────────────────────────────────────────────────────── */

@media (max-width: 760px) {
  .bt-page { padding: 20px 14px 70px; }
  .bt-header { flex-direction: column; align-items: stretch; gap: 12px; }
  .bt-header h1 { font-size: 32px; }
  .bt-head-actions { justify-content: space-between; }
  .bt-stats > div { flex: 1 1 45%; padding: 14px; }
  .bt-stats > div:nth-child(2) { border-right: none; }
  .bt-stat-n { font-size: 27px; }

  .bt-run-top { flex-wrap: wrap; }
  .bt-run-pos { text-align: left; width: 100%; }
  .bt-maths > div { padding: 9px 6px; }
  .bt-maths b { font-size: 19px; }

  .bt-variant-top { flex-wrap: wrap; }
  .bt-variant-id { flex: 1 1 60%; }
  .bt-variant-nums { text-align: left; }
  .bt-variant-planned { margin-left: 0; }

  .bt-run-actions .btn { flex: 1 1 auto; }

  .bt-cand { flex-wrap: wrap; gap: 10px; }
  .bt-cand-main { flex: 1 1 60%; }
  .bt-cand-go { width: 100%; justify-content: center; }

  /* Bottom sheet on phones — the reachable place for a thumb. */
  .bt-overlay { align-items: flex-end; padding: 0; }
  .bt-sheet, .bt-sheet-wide {
    max-width: none; max-height: 92vh; border-left: none; border-right: none;
  }
  .bt-sheet-foot .btn { flex: 1 1 0; }
}
`;
