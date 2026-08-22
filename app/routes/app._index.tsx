import { useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useFetcher } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";
// NOTE: import these statically, NOT via `await import(...)`. picklist.server is
// server-only (`.server.ts`), so there's no client-bundle reason to defer it.
// With a dynamic import, rollup can't see that this action calls generatePickList
// WITH a date-bearing options object; combined with api.pick-list.ts calling it
// without options, rollup "proves" options.startDate is always falsy and
// dead-code-eliminates the entire created_at date filter from buildQueryString.
// A static import keeps this dated call site analyzable so the filter survives.
import {
  generatePickList,
  formatPickListAsText,
  filterByProductName,
  fetchGrantedScopes,
} from "../utils/picklist.server";
// Static for the same reason as above — never switch this to await import().
import { getStageMap } from "../utils/tracker.server";
import {
  COLUMN_LABELS,
  STAGES,
  STAGE_LABELS,
  UNTRIAGED,
  columnFor,
  isStage,
  isStatus,
  type BoardColumn,
} from "../utils/tracking";

// ─── Server ──────────────────────────────────────────────────────────────────

/**
 * Shopify only exposes orders from the last 60 days to an app unless that app
 * has been granted the `read_all_orders` scope (which Shopify must approve).
 * Beyond that window the API returns nothing at all — the orders are still
 * visible in the Shopify Admin, which makes an empty pick list look like a bug.
 * Rather than render a bare "No products to pick", say exactly why.
 */
const ORDER_HISTORY_DAYS = 60;

/** True when the requested start date reaches past Shopify's 60-day window. */
function reachesPastHistoryWindow(startDate?: string | null): boolean {
  if (!startDate) return false;
  const start = Date.parse(`${startDate}T00:00:00Z`);
  if (Number.isNaN(start)) return false;
  return start < Date.now() - ORDER_HISTORY_DAYS * 86_400_000;
}

function orderHistoryWarning(): string {
  const cutoff = new Date(Date.now() - ORDER_HISTORY_DAYS * 86_400_000)
    .toISOString()
    .slice(0, 10);
  return (
    `Shopify only lets this app read orders from the last ${ORDER_HISTORY_DAYS} days ` +
    `(back to ${cutoff}). Orders placed before that date can't be fetched, so they ` +
    `won't appear here — even though you can still see them in your Shopify admin. ` +
    `This app is still waiting on the "read all orders" permission, which Shopify ` +
    `must approve and which needs the app to be re-installed once granted.`
  );
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return null;
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);

  try {
    const formData = await request.formData();
    const startDate = formData.get("startDate") as string | null;
    const endDate = formData.get("endDate") as string | null;
    const searchKeyword = formData.get("searchKeyword") as string | null;
    const sortBy = (formData.get("sortBy") as string | null) || "alpha";
    const showSku = formData.get("showSku") !== "false";
    const showVariantQuantity = formData.get("showVariantQuantity") !== "false";

    console.log("========== PICK LIST REQUEST ==========");
    console.log({ startDate, endDate, sortBy, searchKeyword, showSku, showVariantQuantity });

    let pickList = await generatePickList(admin, {
      startDate: startDate || undefined,
      endDate: endDate || undefined,
      sortBy: sortBy as any,
    });

    if (searchKeyword) {
      pickList = filterByProductName(pickList, searchKeyword);
    }

    // Stamp each constituent order line with its production stage so the
    // client can filter the list by stage without another round-trip. One
    // query for the whole list; lines with no tracker row stay untriaged.
    const lineIds = pickList.flatMap((p: any) =>
      p.variants.flatMap((v: any) => v.lines.map((l: any) => l.lineItemId))
    );
    const stageMap = await getStageMap(session.shop, lineIds);
    for (const p of pickList as any[]) {
      for (const v of p.variants) {
        for (const l of v.lines) {
          const t = stageMap.get(l.lineItemId);
          l.status = t?.status ?? null;
          l.stage = t?.stage ?? null;
        }
      }
    }

    const formattedText = formatPickListAsText(pickList, {
      showSku,
      showVariantQuantity,
    });

    // Only warn about the 60-day limit when the range actually reaches past it
    // AND the app genuinely lacks read_all_orders — otherwise a correctly
    // permissioned app would keep nagging about a limit that no longer applies.
    // Also logs the live granted scopes, which is the only reliable way to tell
    // whether a SCOPES change has actually taken effect on the access token.
    let historyWarning: string | undefined;
    if (reachesPastHistoryWindow(startDate)) {
      const grantedScopes = await fetchGrantedScopes(admin);
      if (!grantedScopes.includes("read_all_orders")) {
        historyWarning = orderHistoryWarning();
      }
    }

    return { pickList, formattedText, success: true, historyWarning };
  } catch (error) {
    console.error("Error generating pick list:", error);
    return {
      success: false,
      error: `Failed to generate pick list: ${
        error instanceof Error ? error.message : "Unknown error"
      }`,
    };
  }
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Returns a Shopify CDN image URL resized to `width` px (Shopify scales the
 * height proportionally and re-encodes on the fly — never cropped, since we
 * only ever pass width, never crop/height). Without a width, the CDN serves
 * the original asset at full resolution — fine on screen since the browser
 * only fetches it once, but when window.print() rasterizes the page, those
 * full-resolution originals get embedded into the PDF at full size
 * regardless of how small the <img> is drawn. That mismatch is what was
 * making the printed PDF huge. Requesting a sized-down version keeps the
 * printed photos sharp while cutting the embedded image bytes drastically
 * versus a full-resolution original. `quality` (1–100) controls JPEG/PNG
 * compression independent of size — kept high here since manufacturing
 * needs to read fine jewelry detail off the printed sheet.
 */
function shopifyImg(
  url: string | undefined,
  width?: number,
  quality?: number
): string {
  if (!url) return "";
  if (!width && !quality) return url;
  try {
    const resized = new URL(url);
    if (width) resized.searchParams.set("width", String(width));
    if (quality) resized.searchParams.set("quality", String(quality));
    return resized.toString();
  } catch {
    // Not a parseable absolute URL — fall back to the original.
    return url;
  }
}

// Widths/quality requested from Shopify's CDN. A single <img> per card now
// serves both screen and print (the print stylesheet just reshapes the cards),
// so we request the print-grade size — sharp on paper, still modest on screen.
const PRINT_IMG_WIDTH = 640;
const PRINT_IMG_QUALITY = 90;

// ─── Print stylesheet (shared) ───────────────────────────────────────────────
// The rules that style the printable tables. Used in two places: gated behind
// @media print on the embedded page, AND applied directly inside the standalone
// print document we open in a new tab (see handlePrint). Keeping it in one const
// means the on-page print preview and the new-tab document can never drift.
const PRINT_LIST_CSS = `
  #pick-list-print { display: block; font-family: var(--font-body); font-size: 9pt; color: #201e1d; }
  .ph { margin-bottom: 6mm; padding-bottom: 3mm; border-bottom: 2px solid #201e1d; }
  .ph-eyebrow { font-family: var(--font-heading); font-weight: 800; font-size: 7.5pt; letter-spacing: .12em; text-transform: uppercase; color: #ec3013; margin-bottom: 2mm; }
  .ph-title { font-family: var(--font-heading); font-weight: 800; font-size: 22pt; letter-spacing: -.015em; line-height: 1; margin: 0; color: #201e1d; }
  .ph-meta { font-size: 8pt; color: #605d5d; margin-top: 2.5mm; }
  .pg-wrap, .pt-wrap { display: none; }
  #pick-list-print[data-print-mode="manufacturing"] .pg-wrap { display: block; }
  #pick-list-print[data-print-mode="tracking"] .pt-wrap { display: block; }
  table.pm { width:100%; border-collapse:collapse; table-layout:fixed; }
  .pm tr { page-break-inside:avoid; break-inside:avoid; }
  .pm td { width:25%; vertical-align:top; padding:2.5mm; border:1px solid #c9c7c6; }
  .pm td:empty { border:none; }
  .pc { border:none; overflow:hidden; }
  .pc img { width:100%; height:auto; display:block; }
  .pc-noimg { width:100%; height:22mm; background:#eae9e9; display:flex; align-items:center; justify-content:center; font-size:6pt; letter-spacing:.06em; text-transform:uppercase; color:#9b9797; }
  .pc-body { padding:2mm 0 0; }
  .pc-title { font-family:var(--font-heading); font-weight:800; font-size:8pt; line-height:1.2; margin-bottom:1.5mm; color:#201e1d; }
  .pc-vars { font-size:6.5pt; color:#7d7979; line-height:1.45; margin-bottom:2mm; }
  .pc-var-row { margin-bottom:.5mm; }
  .pc-vars b { color:#201e1d; }
  .pc-qty { display:flex; align-items:baseline; justify-content:space-between; gap:2mm; border-top:1.5px solid #201e1d; padding-top:1.5mm; font-family:var(--font-heading); font-weight:800; font-size:13pt; color:#ec3013; }
  .pc-qty::before { content:"To pick"; font-size:5.5pt; letter-spacing:.1em; text-transform:uppercase; color:#7d7979; }
  table.pt { width: 100%; border-collapse: collapse; table-layout: fixed; }
  .pt thead { display: table-header-group; }
  .pt th { text-align:left; font-family:var(--font-body); font-size:7pt; font-weight:600; letter-spacing:.08em; text-transform:uppercase; color:#605d5d; padding:2mm 3mm; border:1px solid #c9c7c6; border-bottom:2px solid #201e1d; }
  .pt td { border:1px solid #c9c7c6; padding:2.5mm 3mm; vertical-align:middle; text-align:left; }
  .pt tbody tr { page-break-inside: avoid; break-inside: avoid; }
  .pt-col-img { width: 40mm; }
  .pt-col-qty { width: 24mm; text-align: center; }
  .pt-col-img img { width: 100%; height: auto; display: block; border:1px solid #c9c7c6; }
  .pt-noimg { width: 100%; height: 28mm; background: #eae9e9; display: flex; align-items: center; justify-content: center; font-size: 6pt; letter-spacing:.06em; text-transform:uppercase; color: #9b9797; }
  .pt-title { font-family:var(--font-heading); font-weight:800; font-size: 10pt; line-height: 1.25; margin-bottom: 1mm; color:#201e1d; }
  .pt-vars { font-size: 7.5pt; color: #7d7979; line-height: 1.55; }
  .pt-var-row { margin-bottom: 0.5mm; }
  .pt-vars b { color:#201e1d; }
  .pt-qty { font-family:var(--font-heading); font-weight:800; text-align: center; font-size: 14pt; color:#ec3013; }
`;

// Minimal tokens + webfont for the standalone print document (it doesn't share
// the app's stylesheet).
const PRINT_DOC_TOKENS = `
  @import url('https://fonts.googleapis.com/css2?family=Archivo:wght@400;600;800&display=swap');
  :root { --font-heading: "Archivo", system-ui, sans-serif; --font-body: "Archivo", system-ui, sans-serif; }
`;

// ─── Icons (lucide, inlined so there's no runtime dependency) ────────────────

type IconProps = { size?: number; sw?: number; stroke?: string };
const iconAttrs = (size: number, sw: number, stroke: string) => ({
  width: size,
  height: size,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke,
  strokeWidth: sw,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
});
const IconBox = ({ size = 18, sw = 2, stroke = "currentColor" }: IconProps) => (
  <svg {...iconAttrs(size, sw, stroke)}>
    <path d="m7.5 4.27 9 5.15" />
    <path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" />
    <path d="m3.3 7 8.7 5 8.7-5" />
    <path d="M12 22V12" />
  </svg>
);
const IconFilter = ({ size = 16, sw = 2, stroke = "currentColor" }: IconProps) => (
  <svg {...iconAttrs(size, sw, stroke)}>
    <line x1="21" x2="14" y1="4" y2="4" />
    <line x1="10" x2="3" y1="4" y2="4" />
    <line x1="21" x2="12" y1="12" y2="12" />
    <line x1="8" x2="3" y1="12" y2="12" />
    <line x1="21" x2="16" y1="20" y2="20" />
    <line x1="12" x2="3" y1="20" y2="20" />
    <line x1="14" x2="14" y1="2" y2="6" />
    <line x1="8" x2="8" y1="10" y2="14" />
    <line x1="16" x2="16" y1="18" y2="22" />
  </svg>
);
const IconChevron = ({ up = false, size = 15, stroke = "currentColor" }: IconProps & { up?: boolean }) => (
  <svg {...iconAttrs(size, 2, stroke)}>
    <path d={up ? "m18 15-6-6-6 6" : "m6 9 6 6 6-6"} />
  </svg>
);
const IconX = ({ size = 15, sw = 2, stroke = "currentColor" }: IconProps) => (
  <svg {...iconAttrs(size, sw, stroke)}>
    <path d="M18 6 6 18" />
    <path d="m6 6 12 12" />
  </svg>
);
const IconSearch = ({ size = 15, sw = 2, stroke = "currentColor" }: IconProps) => (
  <svg {...iconAttrs(size, sw, stroke)}>
    <circle cx="11" cy="11" r="8" />
    <path d="m21 21-4.3-4.3" />
  </svg>
);
const IconPrinter = ({ size = 16, stroke = "currentColor" }: IconProps) => (
  <svg {...iconAttrs(size, 2, stroke)}>
    <path d="M12 16h.01" />
    <path d="M16 16h.01" />
    <path d="M3 19a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V9.5a.5.5 0 0 0-.769-.422l-4.462 2.844A.5.5 0 0 1 15 11.5v-2a.5.5 0 0 0-.769-.422L9.77 11.922A.5.5 0 0 1 9 11.5V5a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1z" />
    <path d="M8 16h.01" />
  </svg>
);
const IconClipboard = ({ size = 16, stroke = "currentColor" }: IconProps) => (
  <svg {...iconAttrs(size, 2, stroke)}>
    <rect width="8" height="4" x="8" y="2" rx="1" ry="1" />
    <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
    <path d="M12 11h4" />
    <path d="M12 16h4" />
    <path d="M8 11h.01" />
    <path d="M8 16h.01" />
  </svg>
);
const IconWarn = ({ size = 18, stroke = "currentColor" }: IconProps) => (
  <svg {...iconAttrs(size, 2, stroke)}>
    <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" />
    <path d="M12 9v4" />
    <path d="M12 17h.01" />
  </svg>
);
const IconError = ({ size = 18, stroke = "currentColor" }: IconProps) => (
  <svg {...iconAttrs(size, 2, stroke)}>
    <circle cx="12" cy="12" r="10" />
    <path d="m15 9-6 6" />
    <path d="m9 9 6 6" />
  </svg>
);
const IconInbox = ({ size = 38, sw = 1.6, stroke = "currentColor" }: IconProps) => (
  <svg {...iconAttrs(size, sw, stroke)}>
    <path d="M22 12h-6l-2 3h-4l-2-3H2" />
    <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
  </svg>
);

// ─── Component ───────────────────────────────────────────────────────────────

export default function Index() {
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();

  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [searchKeyword, setSearchKeyword] = useState("");
  const [sortBy, setSortBy] = useState("alpha");
  const [showSku, setShowSku] = useState(true);
  const [showVariantQuantity, setShowVariantQuantity] = useState(true);
  const [showOrderId, setShowOrderId] = useState(false);
  const [showFilters, setShowFilters] = useState(true);
  // Client-side drill-down: the variant titles chosen from the dropdown.
  // Empty means "all variants" (no collapse). This never hits the server — it
  // just reshapes the already-fetched list, so switching variants is instant.
  const [selectedVariants, setSelectedVariants] = useState<string[]>([]);
  // Production-stage narrowing, e.g. "just what's waiting to be cast".
  // "ALL" = no stage filter (the default).
  const [stageFilter, setStageFilter] = useState<BoardColumn | "ALL">("ALL");
  const [variantMenuOpen, setVariantMenuOpen] = useState(false);
  // Free-text filter for the (potentially long) variant dropdown. Default is
  // empty = show every variant; typing narrows the list client-side.
  const [variantSearch, setVariantSearch] = useState("");
  const variantMenuRef = useRef<HTMLDivElement>(null);
  const variantSearchRef = useRef<HTMLInputElement>(null);
  // Which layout @media print should reveal (set on data-print-mode).
  const [printMode, setPrintMode] = useState<"tracking" | "manufacturing">(
    "manufacturing"
  );

  const isLoading =
    ["loading", "submitting"].includes(fetcher.state) &&
    fetcher.formMethod === "POST";

  // The list as generated by the server (already filtered by keyword/date).
  const rawPickList: any[] = fetcher.data?.pickList ?? [];
  // Present only when the requested start date reaches past Shopify's 60-day
  // order-history limit (see orderHistoryWarning above).
  const historyWarning: string | undefined =
    fetcher.data && "historyWarning" in fetcher.data
      ? (fetcher.data.historyWarning as string | undefined)
      : undefined;

  // Every distinct variant title present in the current results, for the
  // "Variant" drill-down dropdown. Recomputed whenever a new list arrives.
  /**
   * The list narrowed to one production stage.
   *
   * Filtering happens at the ORDER LINE level, not the product level: a
   * product can have three pieces in Casting and two in Polishing, and asking
   * for "Casting" must show a quantity of three. So we keep only the matching
   * lines, then rebuild every number derived from them — the variant's
   * quantity, its order numbers, and the product total.
   */
  const stageFiltered: any[] = useMemo(() => {
    if (stageFilter === "ALL") return rawPickList;

    return rawPickList
      .map((p: any) => {
        const variants = p.variants
          .map((v: any) => {
            const lines = (v.lines ?? []).filter(
              (l: any) =>
                columnFor(
                  isStatus(l.status) ? l.status : null,
                  isStage(l.stage) ? l.stage : null
                ) === stageFilter
            );
            if (lines.length === 0) return null;
            return {
              ...v,
              lines,
              quantity: lines.reduce((s: number, l: any) => s + l.quantity, 0),
              orderNumbers: Array.from(
                new Set(lines.map((l: any) => l.orderName))
              ),
            };
          })
          .filter(Boolean);

        if (variants.length === 0) return null;
        return {
          ...p,
          variants,
          totalQuantity: variants.reduce(
            (s: number, v: any) => s + v.quantity,
            0
          ),
        };
      })
      .filter(Boolean);
  }, [rawPickList, stageFilter]);

  // Variant options follow the stage filter, so the dropdown only ever offers
  // variants that are actually present in what's on screen.
  const variantOptions: string[] = useMemo(() => {
    const set = new Set<string>();
    for (const p of stageFiltered) {
      for (const v of p.variants) set.add(v.variantTitle);
    }
    return Array.from(set).sort((a, b) =>
      a.toLowerCase().localeCompare(b.toLowerCase())
    );
  }, [stageFiltered]);

  // The variant options actually shown in the dropdown, narrowed by the search
  // box. Empty search = every variant (the default).
  const filteredVariantOptions: string[] = useMemo(() => {
    const q = variantSearch.trim().toLowerCase();
    if (!q) return variantOptions;
    return variantOptions.filter((v) => v.toLowerCase().includes(q));
  }, [variantOptions, variantSearch]);

  // The list actually rendered/printed. Collapse each product to the selected
  // variants (their union) and recalculate its total, then sort client-side so
  // both the variant filter and the sort control take effect instantly.
  const pickList: any[] = useMemo(() => {
    const chosen = new Set(selectedVariants);
    let list =
      selectedVariants.length === 0
        ? stageFiltered.slice()
        : stageFiltered
            .map((p) => {
              const variants = p.variants.filter((v: any) =>
                chosen.has(v.variantTitle)
              );
              if (variants.length === 0) return null;
              const totalQuantity = variants.reduce(
                (s: number, v: any) => s + v.quantity,
                0
              );
              return { ...p, variants, totalQuantity };
            })
            .filter(Boolean);

    const t = (d: string) => new Date(d).getTime();
    list.sort((a: any, b: any) => {
      switch (sortBy) {
        case "old-to-new":
          return t(a.earliestCreatedAt) - t(b.earliestCreatedAt);
        case "new-to-old":
          return t(b.latestCreatedAt) - t(a.latestCreatedAt);
        case "qty-high-to-low":
          return b.totalQuantity - a.totalQuantity;
        case "qty-low-to-high":
          return a.totalQuantity - b.totalQuantity;
        default:
          return a.productTitle
            .toLowerCase()
            .localeCompare(b.productTitle.toLowerCase());
      }
    });
    return list;
  }, [stageFiltered, selectedVariants, sortBy]);

  // Drop any selected variants that are no longer present (new list generated,
  // keyword changed) so we never show an empty result for a stale selection.
  useEffect(() => {
    const stillPresent = selectedVariants.filter((v) =>
      variantOptions.includes(v)
    );
    if (stillPresent.length !== selectedVariants.length) {
      setSelectedVariants(stillPresent);
    }
  }, [variantOptions, selectedVariants]);

  // When the menu closes, clear the search so it reopens showing all variants.
  // When it opens, focus the search box for immediate typing (desktop).
  useEffect(() => {
    if (!variantMenuOpen) {
      setVariantSearch("");
      return;
    }
    const id = window.setTimeout(() => variantSearchRef.current?.focus(), 0);
    return () => window.clearTimeout(id);
  }, [variantMenuOpen]);

  // Close the variant menu on an outside click.
  useEffect(() => {
    if (!variantMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (
        variantMenuRef.current &&
        !variantMenuRef.current.contains(e.target as Node)
      ) {
        setVariantMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [variantMenuOpen]);

  const toggleVariant = (vt: string) => {
    setSelectedVariants((prev) =>
      prev.includes(vt) ? prev.filter((x) => x !== vt) : [...prev, vt]
    );
  };

  // Select all currently visible (search-filtered) variants, unioned with any
  // existing selection so a narrowed "select all" never drops earlier picks.
  const selectAllVisible = () => {
    setSelectedVariants((prev) => {
      const set = new Set(prev);
      for (const vt of filteredVariantOptions) set.add(vt);
      return Array.from(set);
    });
  };

  const totalProducts = pickList.length;
  const totalItems = pickList.reduce(
    (sum: number, p: any) => sum + p.totalQuantity,
    0
  );
  // Distinct orders represented by the currently displayed variants.
  const unfulfilledOrders = useMemo(() => {
    const set = new Set<string>();
    for (const p of pickList)
      for (const v of p.variants)
        for (const o of v.orderNumbers ?? []) set.add(o);
    return set.size;
  }, [pickList]);

  const today = new Date().toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
  const stageLabel =
    stageFilter === "ALL" ? "All stages" : COLUMN_LABELS[stageFilter];

  const variantLabel =
    selectedVariants.length === 0
      ? "All variants"
      : selectedVariants.length === 1
        ? selectedVariants[0]
        : `${selectedVariants.length} variants selected`;

  const generated = fetcher.data?.success === true;
  const errored = fetcher.data?.success === false;
  const showIntro = !fetcher.data && !isLoading;
  const showResults = generated && !isLoading && pickList.length > 0;
  const showEmpty = generated && !isLoading && pickList.length === 0;
  const variantHasOptions = variantOptions.length > 0;

  const runGenerate = () => {
    const fd = new FormData();
    if (startDate) fd.append("startDate", startDate);
    if (endDate) fd.append("endDate", endDate);
    if (searchKeyword) fd.append("searchKeyword", searchKeyword);
    fd.append("sortBy", sortBy);
    fd.append("showSku", String(showSku));
    fd.append("showVariantQuantity", String(showVariantQuantity));
    fetcher.submit(fd, { method: "POST" });
  };

  const clearFilters = () => {
    setStartDate("");
    setEndDate("");
    setSearchKeyword("");
    setSortBy("alpha");
    setShowSku(true);
    setShowVariantQuantity(true);
    setShowOrderId(false);
    setSelectedVariants([]);
    setVariantMenuOpen(false);
  };

  const handlePrint = (mode: "tracking" | "manufacturing") => {
    if (!pickList.length) return;
    // Commit the chosen layout before we read the print section's markup.
    flushSync(() => setPrintMode(mode));

    // Printing needs a real top-level browser document. In-frame window.print()
    // prints the wrong frame, and the Shopify NATIVE mobile app's WebView blocks
    // both printing and opening a document outright — there is no web print API
    // there. So if we can't open the document, tell the user how to print.
    const cannotPrint = () =>
      shopify.toast.show(
        "Printing isn't available inside the Shopify mobile app. Open your store in a browser (desktop, or Safari/Chrome on your phone) to print or save as PDF.",
        { isError: true, duration: 6000 }
      );

    const src = document.getElementById("pick-list-print");
    if (!src) {
      cannotPrint();
      return;
    }
    const win = window.open("", "_blank");
    if (!win) {
      cannotPrint();
      return;
    }

    try {
      const title = mode === "manufacturing" ? "Manufacturing list" : "Tracking list";
      win.document.open();
      win.document.write(
        '<!doctype html><html><head><meta charset="utf-8">' +
          '<meta name="viewport" content="width=device-width,initial-scale=1">' +
          "<title>Pick List — " + title + "</title><style>" +
          PRINT_DOC_TOKENS +
          "html,body{margin:0;background:#fff;color:#201e1d;font-family:var(--font-body);}" +
          PRINT_LIST_CSS +
          "#pick-list-print{padding:18px;}" +
          ".pk-bar{position:sticky;top:0;z-index:9;display:flex;gap:8px;padding:12px 16px;" +
          "background:#f3f2f2;border-bottom:2px solid #201e1d;}" +
          ".pk-bar button{font-family:var(--font-heading);font-weight:800;font-size:14px;" +
          "padding:11px 18px;border:1px solid #201e1d;background:#ec3013;color:#fff;cursor:pointer;}" +
          "@media print{.pk-bar{display:none;}#pick-list-print{padding:0;}}" +
          "@page{size:A4 portrait;margin:10mm;}" +
          "</style></head><body>" +
          '<div class="pk-bar"><button onclick="window.print()">Print / Save as PDF</button></div>' +
          src.outerHTML +
          // Auto-open the print dialog once images have loaded; the button is the
          // fallback if a browser blocks the automatic call.
          "<scr" + "ipt>window.addEventListener('load',function(){" +
          "setTimeout(function(){try{window.focus();window.print();}catch(e){}},500);});</scr" + "ipt>" +
          "</body></html>"
      );
      win.document.close();
    } catch {
      try {
        win.close();
      } catch {
        /* ignore */
      }
      cannotPrint();
    }
  };

  useEffect(() => {
    if (fetcher.data?.success) {
      shopify.toast.show("Pick list generated successfully");
    } else if (fetcher.data?.success === false) {
      shopify.toast.show("Failed to generate pick list", { isError: true });
    }
  }, [fetcher.data?.success, shopify]);

  // ── Reused inline styles ────────────────────────────────────────────────
  const eyebrow: React.CSSProperties = {
    fontSize: "11px",
    letterSpacing: ".12em",
    textTransform: "uppercase",
    color: "var(--color-accent)",
    marginBottom: "10px",
  };
  const statCell = (last = false): React.CSSProperties => ({
    flex: 1,
    padding: "20px 22px",
    borderRight: last ? "none" : "1px solid var(--color-divider)",
  });
  const statNum: React.CSSProperties = {
    fontFamily: "var(--font-heading)",
    fontWeight: 800,
    fontSize: "40px",
    lineHeight: 1,
  };
  const statLabel: React.CSSProperties = {
    fontSize: "11px",
    letterSpacing: ".1em",
    textTransform: "uppercase",
    color: "var(--color-neutral-600)",
    marginTop: "6px",
  };
  const dividerRow: React.CSSProperties = {
    borderBottom: "2px solid var(--color-divider)",
  };
  const noticeBox: React.CSSProperties = {
    animation: "pkFade .3s ease",
    border: "1px solid var(--color-divider)",
    borderLeft: "3px solid var(--color-accent)",
    background: "var(--color-accent-100)",
    padding: "16px 18px",
    marginTop: "18px",
    display: "flex",
    gap: "12px",
    alignItems: "flex-start",
  };

  const variantLine = (v: any) => {
    let s = v.variantTitle;
    if (showSku && v.sku) s += ` (${v.sku})`;
    if (showOrderId && v.orderNumbers?.length) s += ` [${v.orderNumbers.join(", ")}]`;
    return s;
  };
  const showVarLines = showVariantQuantity || showSku || showOrderId;

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Archivo:wght@400;600;800&display=swap');

        :root {
          --color-bg: #f3f2f2;
          --color-surface: #eae9e9;
          --color-text: #201e1d;
          --color-accent: #ec3013;
          --color-divider: color-mix(in srgb, #201e1d 40%, transparent);
          --color-neutral-200: #eae7e7;
          --color-neutral-500: #9b9797;
          --color-neutral-600: #7d7979;
          --color-accent-100: #fff2ef;
          --color-accent-700: #ae1800;
          --color-accent-800: #7c1405;
          --font-heading: "Archivo", system-ui, sans-serif;
          --font-body: "Archivo", system-ui, sans-serif;
          --shadow-md: 0 3px 10px color-mix(in srgb, #2d2b2b 16%, transparent);
          --shadow-lg: 0 12px 32px color-mix(in srgb, #2d2b2b 22%, transparent);
        }

        .pk-app *, .pk-app *::before, .pk-app *::after { box-sizing: border-box; }
        .pk-app {
          background: var(--color-bg);
          color: var(--color-text);
          font-family: var(--font-body);
          font-size: 15px;
          line-height: 1.55;
          min-height: 100vh;
          /* Never let content push the page wider than the screen: a single
             overflowing element (long SKU, order-id list, image) expands the
             mobile layout viewport and stops the max-width media queries from
             firing — which reads as "the desktop layout, zoomed out". */
          max-width: 100%;
          overflow-x: hidden;
        }
        /* Long unbroken strings (SKUs, "[#1042, #1051, …]") wrap instead of
           forcing horizontal overflow. */
        .pk-app .pk-card-title,
        .pk-app .pk-vars,
        .pk-app .pk-card-body { overflow-wrap: anywhere; word-break: break-word; }
        .pk-app img { max-width: 100%; }
        .pk-app h1, .pk-app h2, .pk-app h3, .pk-app h4 {
          font-family: var(--font-heading); font-weight: 800;
          line-height: 1.12; letter-spacing: -0.015em; margin: 0 0 8px;
        }
        .pk-app h1 { font-size: 42px; }
        .pk-app h2 { font-size: 32px; }
        .pk-app h3 { font-size: 25px; }
        .pk-app .text-muted { color: color-mix(in srgb, var(--color-text) 55%, transparent); }
        .pk-app a { color: var(--color-accent); text-decoration: none; }

        /* buttons */
        .pk-app .btn {
          display: inline-flex; align-items: center; justify-content: center; gap: 6px;
          cursor: pointer; text-decoration: none;
          font-family: var(--font-heading); font-weight: 800; font-size: 14px; line-height: 1.2;
          color: var(--color-text); background: transparent;
          border: 1px solid transparent; padding: 8px 14px; border-radius: 0;
        }
        .pk-app .btn svg { display: block; }
        .pk-app .btn:disabled { opacity: 0.45; cursor: not-allowed; }
        .pk-app .btn-primary { background: var(--color-accent); color: var(--color-bg); }
        .pk-app .btn-primary:not(:disabled):hover { background: var(--color-accent-700); }
        .pk-app .btn-secondary { border-color: var(--color-divider); }
        .pk-app .btn-secondary:hover { background: color-mix(in srgb, var(--color-text) 7%, transparent); }

        /* forms */
        .pk-app .field > label {
          display: block; font-size: 12px; margin-bottom: 5px;
          color: color-mix(in srgb, var(--color-text) 70%, transparent);
        }
        .pk-app .input {
          width: 100%; min-height: 36px; padding: 6px 10px; font: inherit;
          font-size: 14px; color: var(--color-text); caret-color: var(--color-accent);
          background: var(--color-surface);
          border: 1px solid var(--color-divider); border-radius: 0;
        }
        .pk-app .input:hover { border-color: color-mix(in srgb, var(--color-text) 45%, transparent); }
        .pk-app .input:focus-visible { border-color: var(--color-accent); outline: none; }
        .pk-app input[type="checkbox"].pk-chk {
          width: 16px; height: 16px; accent-color: var(--color-accent); cursor: pointer; flex: none;
        }
        .pk-app :focus-visible { outline: 2px solid var(--color-accent); outline-offset: 2px; }

        /* ── Variant dropdown ───────────────────────────────────────────
           Desktop: an anchored popover. Mobile: a bottom sheet (see the
           mobile media query, which overrides these with !important). */
        .pk-vmenu-backdrop { display: none; }
        .pk-vmenu {
          position: absolute; top: 100%; left: 0; right: 0; z-index: 30;
          margin-top: 4px; display: flex; flex-direction: column;
          max-height: 340px; background: var(--color-bg);
          border: 1px solid var(--color-divider); box-shadow: var(--shadow-lg);
        }
        .pk-vmenu-head {
          flex: none; padding: 8px; border-bottom: 1px solid var(--color-divider);
          background: var(--color-bg);
        }
        .pk-vmenu-grip { display: none; }
        .pk-vmenu-actions {
          display: flex; align-items: center; gap: 10px; margin-top: 8px;
        }
        .pk-vmenu-actions button {
          background: transparent; border: none; padding: 2px 0; cursor: pointer;
          font-family: var(--font-heading); font-weight: 800; font-size: 12px;
          color: var(--color-accent);
        }
        .pk-vmenu-actions button:hover:not(:disabled) { text-decoration: underline; text-underline-offset: 2px; }
        .pk-vmenu-actions button:disabled {
          color: color-mix(in srgb, var(--color-text) 34%, transparent); cursor: default;
        }
        .pk-vmenu-actions-sep {
          width: 1px; height: 12px; background: var(--color-divider);
        }
        .pk-vmenu-list { flex: 1 1 auto; overflow-y: auto; padding: 4px; }
        .pk-vmenu-opt {
          display: flex; align-items: flex-start; gap: 9px; padding: 9px 10px;
          font-size: 14px; cursor: pointer; color: var(--color-text);
        }
        .pk-vmenu-opt:hover {
          background: color-mix(in srgb, var(--color-text) 5%, transparent);
        }
        .pk-vmenu-foot {
          flex: none; display: flex; align-items: center;
          justify-content: space-between; gap: 10px;
          padding: 8px 10px; border-top: 1px solid var(--color-divider);
          background: var(--color-bg);
        }

        /* tags */
        .pk-app .tag {
          display: inline-flex; align-items: center; font-size: 11px;
          letter-spacing: 0.02em; padding: 3px 10px; border-radius: 0;
        }
        .pk-app .tag-accent { background: var(--color-accent-100); color: var(--color-accent-800); }

        .pk-card { transition: box-shadow 180ms ease; }
        .pk-card:hover { box-shadow: var(--shadow-md); }

        @keyframes pkFade { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
        @keyframes pkPulse { 0%,100% { opacity: .45; } 50% { opacity: .85; } }

        @media screen { #pick-list-print { display: none !important; } }

        /* ── Mobile ─────────────────────────────────────────────────── */
        @media (max-width: 640px) {
          .pk-page { padding: 22px 16px 44px !important; }
          .pk-header { flex-direction: column; align-items: stretch !important; gap: 14px !important; }
          .pk-header h1 { font-size: 32px !important; }
          .pk-gen { width: 100% !important; justify-content: center; }
          /* Stats: keep three across but shrink the big numerals + padding. */
          .pk-stats > div { padding: 14px 12px !important; }
          .pk-stats > div > div:first-child { font-size: 26px !important; }
          /* Stack filters into one clean full-width column. The base grid uses
             align-items:flex-end (fine for a row); in a column that would pin
             each field to the right at content width, so force stretch + full
             width here. */
          .pk-filter-grid {
            flex-direction: column !important;
            align-items: stretch !important;
            gap: 14px !important;
          }
          .pk-filter-grid > * {
            flex: 0 0 auto !important;
            width: 100% !important;
            min-width: 0 !important;
          }
          .pk-filter-grid .field > label { text-align: left !important; }
          .pk-toggles { flex-direction: column !important; align-items: stretch !important; gap: 16px !important; }
          /* Stack the display toggles into a tappable vertical list. */
          .pk-toggles > div { flex-direction: column !important; align-items: flex-start !important; gap: 14px !important; }
          .pk-toggles .btn { width: 100%; justify-content: center; }
          .pk-resbar { flex-direction: column; align-items: stretch !important; gap: 12px; }
          .pk-print-btns { width: 100%; flex-direction: column; }
          .pk-print-btns .btn { width: 100%; }
          /* Two products per row on phones. */
          .pk-grid { grid-template-columns: repeat(2, 1fr) !important; gap: 12px !important; }
          .pk-panel { padding: 24px 18px !important; gap: 16px !important; }
          .pk-panel svg { width: 30px !important; height: 30px !important; }
          /* Comfortable touch targets. */
          .pk-app .input, .pk-app .btn { min-height: 44px; }
          .pk-chk { width: 20px !important; height: 20px !important; }

          /* Variant dropdown becomes a full-width bottom sheet for clean,
             thumb-friendly interaction instead of a cramped popover. */
          .pk-vmenu-backdrop {
            display: block !important;
            position: fixed !important; inset: 0 !important;
            background: rgba(0, 0, 0, 0.4); z-index: 900 !important;
            animation: pkFade 160ms ease;
          }
          .pk-vmenu {
            position: fixed !important;
            top: auto !important; left: 0 !important; right: 0 !important;
            bottom: 0 !important; margin: 0 !important; z-index: 901 !important;
            max-height: 78vh !important;
            border: none !important; border-top: 2px solid var(--color-text) !important;
            box-shadow: 0 -10px 34px rgba(0, 0, 0, 0.28) !important;
            padding-bottom: env(safe-area-inset-bottom, 0px);
            animation: pkSheet 240ms cubic-bezier(0.22, 1, 0.36, 1);
          }
          .pk-vmenu-head { padding: 8px 14px 12px !important; }
          .pk-vmenu-grip {
            display: block !important;
            width: 40px; height: 4px; margin: 4px auto 12px;
            border-radius: 999px;
            background: color-mix(in srgb, var(--color-text) 22%, transparent);
          }
          .pk-vmenu-list { padding: 4px 6px !important; }
          .pk-vmenu-opt { padding: 13px 12px !important; font-size: 15px !important; }
          .pk-vmenu-foot { padding: 12px 14px !important; }
        }
        @keyframes pkSheet { from { transform: translateY(100%); } to { transform: none; } }
        @media (max-width: 400px) {
          .pk-grid { grid-template-columns: 1fr !important; }
          .pk-header h1 { font-size: 28px !important; }
          .pk-stats > div > div:first-child { font-size: 23px !important; }
        }

        /* ── Print: hide the on-screen app, reveal the dedicated table layout.
           Real <table> elements (not CSS grid) so the sheet pastes into Google
           Docs / Word as an editable table. Styling lives in PRINT_LIST_CSS,
           shared with the standalone print document (see handlePrint). ─────── */
        @media print {
          .pk-app { display: none !important; }
          ${PRINT_LIST_CSS}
        }
        @page { size: A4 portrait; margin: 10mm; }
      `}</style>

      {/* ──────────────────────────────────────────────────────────────────── */}
      {/* Print-only section — real <table> layouts so the sheet pastes into   */}
      {/* Google Docs / Word as an editable table. Hidden on screen; revealed   */}
      {/* by @media print, which shows only the wrapper matching printMode.     */}
      {/* ──────────────────────────────────────────────────────────────────── */}
      <div id="pick-list-print" data-print-mode={printMode}>
        <div className="ph">
          <div className="ph-eyebrow">
            Unfulfilled orders · {today}
            {/* A stage-filtered sheet is a PARTIAL list. Say so on the paper —
                otherwise the bench has no way to tell it isn't everything. */}
            {stageFilter !== "ALL" && ` · ${stageLabel}`}
          </div>
          <div className="ph-title">Pick List</div>
          <div className="ph-meta">
            {printMode === "manufacturing" ? "Manufacturing list" : "Tracking list"}
            {stageFilter !== "ALL" && (
              <>
                &nbsp;·&nbsp; Stage: <b>{stageLabel}</b>
              </>
            )}
            &nbsp;·&nbsp; Products: <b>{totalProducts}</b>
            &nbsp;·&nbsp; Pieces to pick: <b>{totalItems}</b>
          </div>
        </div>

        {/* Manufacturing list — dense 4-up table (printMode === "manufacturing") */}
        <div className="pg-wrap">
          <table className="pm">
            <tbody>
              {Array.from({ length: Math.ceil(pickList.length / 4) }).map((_, rowIndex) => (
                <tr key={rowIndex}>
                  {[0, 1, 2, 3].map((colIndex) => {
                    const product = pickList[rowIndex * 4 + colIndex];
                    return (
                      <td key={colIndex}>
                        {product && (
                          <div className="pc">
                            {product.productImage?.url ? (
                              <img
                                src={shopifyImg(product.productImage.url, PRINT_IMG_WIDTH, PRINT_IMG_QUALITY)}
                                alt={product.productImage?.altText || product.productTitle}
                              />
                            ) : (
                              <div className="pc-noimg">No image</div>
                            )}
                            <div className="pc-body">
                              <div className="pc-title">{product.productTitle}</div>
                              {showVariantQuantity && (
                                <div className="pc-vars">
                                  {product.variants.map((v: any, i: number) => (
                                    <div key={i} className="pc-var-row">
                                      {v.variantTitle}
                                      {showSku && v.sku ? ` (${v.sku})` : ""}
                                      {showOrderId && v.orderNumbers?.length > 0
                                        ? ` [${v.orderNumbers.join(", ")}]`
                                        : ""}
                                      : <b>{v.quantity}</b>
                                    </div>
                                  ))}
                                </div>
                              )}
                              {!showVariantQuantity && (showSku || showOrderId) && (
                                <div className="pc-vars">
                                  {product.variants.map((v: any, i: number) => (
                                    <div key={i}>
                                      {showSku && v.sku ? `SKU: ${v.sku}` : ""}
                                      {showOrderId && v.orderNumbers?.length > 0
                                        ? `${showSku && v.sku ? " " : ""}[${v.orderNumbers.join(", ")}]`
                                        : ""}
                                    </div>
                                  ))}
                                </div>
                              )}
                              <div className="pc-qty">{product.totalQuantity}</div>
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

        {/* Tracking list — one row per product (printMode === "tracking") */}
        <div className="pt-wrap">
          <table className="pt">
            <thead>
              <tr>
                <th className="pt-col-img">Image</th>
                <th>Product &amp; Variant Details</th>
                <th className="pt-col-qty">Qty to Pick</th>
              </tr>
            </thead>
            <tbody>
              {pickList.map((product: any) => (
                <tr key={product.productId}>
                  <td className="pt-col-img">
                    {product.productImage?.url ? (
                      <img
                        src={shopifyImg(product.productImage.url, PRINT_IMG_WIDTH, PRINT_IMG_QUALITY)}
                        alt={product.productImage?.altText || product.productTitle}
                      />
                    ) : (
                      <div className="pt-noimg">No image</div>
                    )}
                  </td>
                  <td>
                    <div className="pt-title">{product.productTitle}</div>
                    {showVariantQuantity && (
                      <div className="pt-vars">
                        {product.variants.map((v: any, i: number) => (
                          <div key={i} className="pt-var-row">
                            {v.variantTitle}
                            {showSku && v.sku ? ` (${v.sku})` : ""}
                            {showOrderId && v.orderNumbers?.length > 0
                              ? ` [${v.orderNumbers.join(", ")}]`
                              : ""}
                            : <b>{v.quantity}</b>
                          </div>
                        ))}
                      </div>
                    )}
                    {!showVariantQuantity && (showSku || showOrderId) && (
                      <div className="pt-vars">
                        {product.variants.map((v: any, i: number) => (
                          <div key={i}>
                            {showSku && v.sku ? `SKU: ${v.sku}` : ""}
                            {showOrderId && v.orderNumbers?.length > 0
                              ? `${showSku && v.sku ? "  " : ""}[${v.orderNumbers.join(", ")}]`
                              : ""}
                          </div>
                        ))}
                      </div>
                    )}
                  </td>
                  <td className="pt-col-qty">
                    <div className="pt-qty">{product.totalQuantity}</div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="pk-app">
        <div
          className="pk-page"
          style={{ maxWidth: "1100px", margin: "0 auto", padding: "34px 34px 56px" }}
        >
          {/* ── Header ─────────────────────────────────────────────── */}
          <div
            className="pk-header pk-noprint"
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "flex-end",
              gap: "24px",
              paddingBottom: "22px",
              ...dividerRow,
            }}
          >
            <div>
              <div style={eyebrow}>Unfulfilled orders · {today}</div>
              <h1 style={{ margin: 0, fontSize: "clamp(30px,6vw,46px)" }}>Pick List</h1>
            </div>
            <button
              className="btn btn-primary pk-gen"
              onClick={runGenerate}
              disabled={isLoading}
              style={{ padding: "11px 18px", fontSize: "15px" }}
            >
              <IconBox size={18} />
              {isLoading ? "Generating…" : "Generate list"}
            </button>
          </div>

          {/* ── Stats ──────────────────────────────────────────────── */}
          {generated && !isLoading && (
            <div
              className="pk-stats pk-noprint"
              style={{ display: "flex", ...dividerRow }}
            >
              <div style={statCell()}>
                <div style={statNum}>{totalProducts}</div>
                <div style={statLabel}>Products</div>
              </div>
              <div style={statCell()}>
                <div style={{ ...statNum, color: "var(--color-accent)" }}>{totalItems}</div>
                {/* "Pieces", not "items" — the same word the Track board uses,
                    so the two pages' totals visibly describe the same thing. */}
                <div style={statLabel}>Pieces to pick</div>
              </div>
              <div style={statCell(true)}>
                <div style={statNum}>{unfulfilledOrders}</div>
                <div style={statLabel}>Orders</div>
              </div>
            </div>
          )}

          {/* ── Filters ────────────────────────────────────────────── */}
          <div className="pk-noprint" style={{ marginTop: "2px" }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: "12px",
                padding: "14px 0",
                ...dividerRow,
              }}
            >
              <button
                onClick={() => setShowFilters((v) => !v)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "9px",
                  background: "transparent",
                  border: "none",
                  cursor: "pointer",
                  fontFamily: "var(--font-heading)",
                  fontWeight: 800,
                  fontSize: "14px",
                  color: "var(--color-text)",
                  padding: 0,
                }}
              >
                <IconFilter size={16} />
                Filters
                <span style={{ opacity: 0.6, display: "inline-flex" }}>
                  <IconChevron up={showFilters} size={15} />
                </span>
              </button>
              <span style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
                {stageFilter !== "ALL" && (
                  <span className="tag tag-accent">{stageLabel}</span>
                )}
                {selectedVariants.length > 0 && (
                  <span className="tag tag-accent">
                    {selectedVariants.length} variant filter
                  </span>
                )}
              </span>
            </div>

            {showFilters && (
              <>
                <div
                  className="pk-filter-grid"
                  style={{
                    display: "flex",
                    flexWrap: "wrap",
                    gap: "16px",
                    alignItems: "flex-end",
                    padding: "22px 0",
                    ...dividerRow,
                  }}
                >
                  <div className="field" style={{ flex: "1 1 130px" }}>
                    <label>Start date</label>
                    <input
                      className="input"
                      type="date"
                      value={startDate}
                      onChange={(e) => setStartDate(e.target.value)}
                    />
                  </div>
                  <div className="field" style={{ flex: "1 1 130px" }}>
                    <label>End date</label>
                    <input
                      className="input"
                      type="date"
                      value={endDate}
                      onChange={(e) => setEndDate(e.target.value)}
                    />
                  </div>
                  <div className="field" style={{ flex: "2 1 200px" }}>
                    <label>Search product</label>
                    <input
                      className="input"
                      placeholder="Keyword…"
                      value={searchKeyword}
                      onChange={(e) => setSearchKeyword(e.target.value)}
                    />
                  </div>

                  {/* Variant multi-select — client-side, instant. */}
                  <div
                    className="field"
                    ref={variantMenuRef}
                    style={{ flex: "1 1 180px", position: "relative" }}
                  >
                    <label>Variant</label>
                    <button
                      className="input"
                      type="button"
                      disabled={!variantHasOptions}
                      aria-haspopup="listbox"
                      aria-expanded={variantMenuOpen}
                      onClick={() => setVariantMenuOpen((v) => !v)}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        gap: "8px",
                        cursor: variantHasOptions ? "pointer" : "not-allowed",
                        textAlign: "left",
                        fontFamily: "var(--font-heading)",
                        fontWeight: 800,
                        fontSize: "13px",
                        opacity: variantHasOptions ? 1 : 0.55,
                      }}
                    >
                      <span
                        style={{
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {variantHasOptions ? variantLabel : "Generate a list first"}
                      </span>
                      <span style={{ opacity: 0.55, flex: "none", display: "inline-flex" }}>
                        <IconChevron size={15} />
                      </span>
                    </button>

                    {variantMenuOpen && variantHasOptions && (
                      <>
                        {/* Dimmed backdrop — shown only on mobile, where the
                            menu becomes a bottom sheet. Tap to close. */}
                        <div
                          className="pk-vmenu-backdrop"
                          onClick={() => setVariantMenuOpen(false)}
                          aria-hidden="true"
                        />
                        <div
                          className="pk-vmenu"
                          role="listbox"
                          aria-multiselectable="true"
                        >
                          {/* Sticky header: grip (mobile) + search box. */}
                          <div className="pk-vmenu-head">
                            <div className="pk-vmenu-grip" aria-hidden="true" />
                            <div style={{ position: "relative" }}>
                              <span
                                style={{
                                  position: "absolute",
                                  left: 10,
                                  top: "50%",
                                  transform: "translateY(-50%)",
                                  opacity: 0.5,
                                  display: "inline-flex",
                                  pointerEvents: "none",
                                }}
                              >
                                <IconSearch size={15} />
                              </span>
                              <input
                                ref={variantSearchRef}
                                className="input"
                                type="text"
                                placeholder="Search variants…"
                                value={variantSearch}
                                onChange={(e) => setVariantSearch(e.target.value)}
                                style={{ paddingLeft: 32 }}
                              />
                            </div>
                            {/* Bulk actions: select / unselect all (visible). */}
                            <div className="pk-vmenu-actions">
                              <button
                                type="button"
                                onClick={selectAllVisible}
                                disabled={filteredVariantOptions.length === 0}
                              >
                                Select all
                                {variantSearch.trim()
                                  ? ` (${filteredVariantOptions.length})`
                                  : ""}
                              </button>
                              <span className="pk-vmenu-actions-sep" aria-hidden="true" />
                              <button
                                type="button"
                                onClick={() => setSelectedVariants([])}
                                disabled={selectedVariants.length === 0}
                              >
                                Unselect all
                              </button>
                            </div>
                          </div>

                          {/* Scrollable options. */}
                          <div className="pk-vmenu-list">
                            {filteredVariantOptions.length === 0 ? (
                              <div
                                style={{
                                  padding: "18px 12px",
                                  fontSize: "13px",
                                  color:
                                    "color-mix(in srgb, var(--color-text) 60%, transparent)",
                                }}
                              >
                                No variants match “{variantSearch.trim()}”.
                              </div>
                            ) : (
                              filteredVariantOptions.map((vt) => (
                                <label
                                  key={vt}
                                  role="option"
                                  aria-selected={selectedVariants.includes(vt)}
                                  className="pk-vmenu-opt"
                                >
                                  <input
                                    type="checkbox"
                                    className="pk-chk"
                                    checked={selectedVariants.includes(vt)}
                                    onChange={() => toggleVariant(vt)}
                                    style={{ marginTop: "2px" }}
                                  />
                                  {/* Full variant name — wrap rather than clip. */}
                                  <span
                                    style={{
                                      whiteSpace: "normal",
                                      overflowWrap: "anywhere",
                                      lineHeight: 1.35,
                                    }}
                                  >
                                    {vt}
                                  </span>
                                </label>
                              ))
                            )}
                          </div>

                          {/* Sticky footer: selection summary + done. */}
                          <div className="pk-vmenu-foot">
                            <span
                              style={{
                                fontFamily: "var(--font-heading)",
                                fontWeight: 800,
                                fontSize: "12px",
                                color: selectedVariants.length
                                  ? "var(--color-accent)"
                                  : "color-mix(in srgb, var(--color-text) 55%, transparent)",
                              }}
                            >
                              {selectedVariants.length
                                ? `${selectedVariants.length} selected`
                                : "All variants"}
                            </span>
                            <button
                              type="button"
                              className="btn btn-primary"
                              onClick={() => setVariantMenuOpen(false)}
                              style={{
                                minHeight: 0,
                                padding: "8px 18px",
                                fontSize: "12px",
                              }}
                            >
                              Done
                            </button>
                          </div>
                        </div>
                      </>
                    )}
                  </div>

                  {/* Production stage — narrows the list to one bench's work,
                      e.g. print just what's waiting to be cast. */}
                  <div className="field" style={{ flex: "1 1 160px" }}>
                    <label>Stage</label>
                    <select
                      className="input"
                      value={stageFilter}
                      onChange={(e) =>
                        setStageFilter(e.target.value as BoardColumn | "ALL")
                      }
                      style={{
                        fontFamily: "var(--font-heading)",
                        fontWeight: 800,
                        fontSize: "13px",
                        cursor: "pointer",
                      }}
                    >
                      <option value="ALL">All stages</option>
                      <option value={UNTRIAGED}>Untriaged</option>
                      {STAGES.map((s) => (
                        <option key={s} value={s}>
                          {STAGE_LABELS[s]}
                        </option>
                      ))}
                      <option value="READY_TO_SHIP">Ready to ship</option>
                    </select>
                  </div>

                  <div className="field" style={{ flex: "1 1 170px" }}>
                    <label>Sort by</label>
                    <select
                      className="input"
                      value={sortBy}
                      onChange={(e) => setSortBy(e.target.value)}
                      style={{
                        fontFamily: "var(--font-heading)",
                        fontWeight: 800,
                        fontSize: "13px",
                        cursor: "pointer",
                      }}
                    >
                      <option value="alpha">Alphabetical (A–Z)</option>
                      <option value="old-to-new">Order date · old to new</option>
                      <option value="new-to-old">Order date · new to old</option>
                      <option value="qty-high-to-low">Quantity · high to low</option>
                      <option value="qty-low-to-high">Quantity · low to high</option>
                    </select>
                  </div>
                </div>

                <div
                  className="pk-toggles"
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    flexWrap: "wrap",
                    gap: "16px",
                    padding: "18px 0",
                    ...dividerRow,
                  }}
                >
                  <div style={{ display: "flex", gap: "24px", flexWrap: "wrap", fontSize: "13px" }}>
                    <label style={{ display: "flex", alignItems: "center", gap: "8px", cursor: "pointer" }}>
                      <input type="checkbox" className="pk-chk" checked={showSku} onChange={(e) => setShowSku(e.target.checked)} />
                      Include SKU
                    </label>
                    <label style={{ display: "flex", alignItems: "center", gap: "8px", cursor: "pointer" }}>
                      <input type="checkbox" className="pk-chk" checked={showVariantQuantity} onChange={(e) => setShowVariantQuantity(e.target.checked)} />
                      Variant quantities
                    </label>
                    <label style={{ display: "flex", alignItems: "center", gap: "8px", cursor: "pointer" }}>
                      <input type="checkbox" className="pk-chk" checked={showOrderId} onChange={(e) => setShowOrderId(e.target.checked)} />
                      Order IDs
                    </label>
                  </div>
                  <button className="btn btn-secondary" onClick={clearFilters}>
                    <IconX size={15} />
                    Clear filters
                  </button>
                </div>
              </>
            )}
          </div>

          {/* ── 60-day warning ─────────────────────────────────────── */}
          {historyWarning && (
            <div className="pk-noprint" style={noticeBox}>
              <span style={{ flex: "none", marginTop: "1px", display: "inline-flex" }}>
                <IconWarn size={18} stroke="var(--color-accent-700)" />
              </span>
              <p style={{ margin: 0, fontSize: "13px", lineHeight: 1.55, color: "var(--color-accent-800)" }}>
                {historyWarning}
              </p>
            </div>
          )}

          {/* ── Error ──────────────────────────────────────────────── */}
          {errored && (
            <div className="pk-noprint" style={{ ...noticeBox, padding: "18px" }}>
              <span style={{ flex: "none", marginTop: "1px", display: "inline-flex" }}>
                <IconError size={18} stroke="var(--color-accent-700)" />
              </span>
              <div>
                <div style={{ fontFamily: "var(--font-heading)", fontWeight: 800, fontSize: "15px", color: "var(--color-accent-800)" }}>
                  Couldn't generate the pick list
                </div>
                <p style={{ margin: "5px 0 0", fontSize: "13px", color: "var(--color-accent-800)" }}>
                  {fetcher.data && "error" in fetcher.data
                    ? (fetcher.data.error as string)
                    : "Something went wrong reaching your store. Check the connection and try again."}
                </p>
                <button className="btn btn-secondary" onClick={runGenerate} style={{ marginTop: "12px" }}>
                  Try again
                </button>
              </div>
            </div>
          )}

          {/* ── Results / intro / loading / empty ──────────────────── */}
          <div className="pk-results" data-print-mode={printMode}>
            {showIntro && (
              <div
                className="pk-panel pk-noprint"
                style={{
                  animation: "pkFade .4s ease",
                  border: "2px solid var(--color-divider)",
                  padding: "38px 30px",
                  marginTop: "28px",
                  display: "flex",
                  gap: "22px",
                  alignItems: "flex-start",
                }}
              >
                <span style={{ flex: "none", display: "inline-flex" }}>
                  <IconBox size={40} sw={1.6} stroke="var(--color-accent)" />
                </span>
                <div>
                  <h3 style={{ margin: "0 0 6px", fontSize: "23px" }}>No pick list yet</h3>
                  <p className="text-muted" style={{ margin: 0, maxWidth: "54ch", lineHeight: 1.6 }}>
                    Set a date range in Filters if you need one, then hit{" "}
                    <b style={{ color: "var(--color-text)" }}>Generate list</b> to pull every
                    unfulfilled order into a single list to pick and pack from.
                  </p>
                </div>
              </div>
            )}

            {isLoading && (
              <div
                className="pk-noprint"
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fill,minmax(min(200px,100%),1fr))",
                  gap: "16px",
                  marginTop: "28px",
                }}
              >
                {Array.from({ length: 8 }).map((_, i) => (
                  <div key={i} style={{ border: "1px solid var(--color-divider)", background: "var(--color-surface)" }}>
                    <div style={{ aspectRatio: "1/1", background: "var(--color-neutral-200)", animation: "pkPulse 1.2s ease-in-out infinite" }} />
                    <div style={{ padding: "14px" }}>
                      <div style={{ height: "12px", background: "var(--color-neutral-200)", marginBottom: "9px", animation: "pkPulse 1.2s ease-in-out infinite" }} />
                      <div style={{ height: "10px", width: "70%", background: "var(--color-neutral-200)", marginBottom: "16px", animation: "pkPulse 1.2s ease-in-out infinite" }} />
                      <div style={{ height: "26px", background: "var(--color-neutral-200)", animation: "pkPulse 1.2s ease-in-out infinite" }} />
                    </div>
                  </div>
                ))}
              </div>
            )}

            {showResults && (
              <>
                <div
                  className="pk-resbar pk-noprint"
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    gap: "16px",
                    marginTop: "30px",
                    marginBottom: "20px",
                  }}
                >
                  <h2 style={{ margin: 0, fontSize: "24px" }}>
                    Products to pick{" "}
                    <span style={{ color: "var(--color-neutral-500)", fontSize: "17px" }}>
                      · {totalProducts}
                    </span>
                  </h2>
                  <div className="pk-print-btns" style={{ display: "flex", gap: "8px" }}>
                    <button className="btn btn-secondary" onClick={() => handlePrint("manufacturing")}>
                      <IconPrinter size={16} />
                      Print manufacturing
                    </button>
                    <button className="btn btn-secondary" onClick={() => handlePrint("tracking")}>
                      <IconClipboard size={16} />
                      Print tracking
                    </button>
                  </div>
                </div>

                <div
                  className="pk-grid"
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(auto-fill,minmax(min(200px,100%),1fr))",
                    gap: "16px",
                  }}
                >
                  {pickList.map((product: any) => (
                    <div
                      key={product.productId}
                      className="pk-card"
                      style={{
                        border: "1px solid var(--color-divider)",
                        background: "var(--color-surface)",
                        display: "flex",
                        flexDirection: "column",
                      }}
                    >
                      <div
                        className="pk-card-imgwrap"
                        style={{
                          position: "relative",
                          aspectRatio: "1/1",
                          borderBottom: "1px solid var(--color-divider)",
                          background: "var(--color-neutral-200)",
                        }}
                      >
                        {product.productImage?.url ? (
                          <img
                            src={shopifyImg(product.productImage.url, PRINT_IMG_WIDTH, PRINT_IMG_QUALITY)}
                            alt={product.productImage?.altText || product.productTitle}
                            style={{ width: "100%", height: "100%", objectFit: "contain", display: "block" }}
                          />
                        ) : (
                          <div
                            style={{
                              width: "100%",
                              height: "100%",
                              display: "flex",
                              alignItems: "center",
                              justifyContent: "center",
                              fontSize: "11px",
                              color: "var(--color-neutral-600)",
                            }}
                          >
                            No image
                          </div>
                        )}
                      </div>
                      <div
                        className="pk-card-body"
                        style={{ padding: "12px 14px 14px", display: "flex", flexDirection: "column", flex: 1 }}
                      >
                        <div className="pk-card-titlewrap" style={{ flex: 1, display: "flex", flexDirection: "column" }}>
                          <div
                            className="pk-card-title"
                            style={{
                              fontFamily: "var(--font-heading)",
                              fontWeight: 800,
                              fontSize: "14px",
                              lineHeight: 1.25,
                              minHeight: "35px",
                            }}
                          >
                            {product.productTitle}
                          </div>
                          {showVarLines && (
                            <div
                              className="pk-vars"
                              style={{
                                fontSize: "12px",
                                color: "var(--color-neutral-600)",
                                margin: "8px 0 14px",
                                lineHeight: 1.6,
                                flex: 1,
                              }}
                            >
                              {product.variants.map((v: any, i: number) => (
                                <div key={i}>
                                  {variantLine(v)}
                                  {showVariantQuantity ? ": " : ""}
                                  {showVariantQuantity && (
                                    <b style={{ color: "var(--color-text)" }}>{v.quantity}</b>
                                  )}
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                        <div
                          className="pk-card-foot"
                          style={{
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "space-between",
                            borderTop: "2px solid var(--color-divider)",
                            paddingTop: "10px",
                            marginTop: "auto",
                          }}
                        >
                          <span style={{ fontSize: "10px", textTransform: "uppercase", letterSpacing: ".1em", color: "var(--color-neutral-600)" }}>
                            To pick
                          </span>
                          <span
                            className="pk-qty"
                            style={{ fontFamily: "var(--font-heading)", fontWeight: 800, fontSize: "22px", color: "var(--color-accent)" }}
                          >
                            {product.totalQuantity}
                          </span>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}

            {showEmpty && (
              <div
                className="pk-panel pk-noprint"
                style={{
                  animation: "pkFade .4s ease",
                  border: "2px solid var(--color-divider)",
                  padding: "44px 30px",
                  marginTop: "28px",
                  display: "flex",
                  gap: "20px",
                  alignItems: "center",
                }}
              >
                <span style={{ flex: "none", display: "inline-flex" }}>
                  <IconInbox size={38} stroke="var(--color-neutral-500)" />
                </span>
                <div>
                  <h3 style={{ margin: "0 0 5px", fontSize: "21px" }}>No products to pick</h3>
                  <p className="text-muted" style={{ margin: 0, maxWidth: "52ch", lineHeight: 1.6 }}>
                    Every order is fulfilled, or nothing matches your filters. Try widening the
                    date range or clearing the search.
                  </p>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
