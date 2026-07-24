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
  const { admin } = await authenticate.admin(request);

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
  const [variantMenuOpen, setVariantMenuOpen] = useState(false);
  const variantMenuRef = useRef<HTMLDivElement>(null);
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
  const variantOptions: string[] = useMemo(() => {
    const set = new Set<string>();
    for (const p of rawPickList) {
      for (const v of p.variants) set.add(v.variantTitle);
    }
    return Array.from(set).sort((a, b) =>
      a.toLowerCase().localeCompare(b.toLowerCase())
    );
  }, [rawPickList]);

  // The list actually rendered/printed. Collapse each product to the selected
  // variants (their union) and recalculate its total, then sort client-side so
  // both the variant filter and the sort control take effect instantly.
  const pickList: any[] = useMemo(() => {
    const chosen = new Set(selectedVariants);
    let list =
      selectedVariants.length === 0
        ? rawPickList.slice()
        : rawPickList
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
  }, [rawPickList, selectedVariants, sortBy]);

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
    // flushSync commits the data-print-mode attribute before window.print()
    // fires, so the sheet reflects whichever button was just clicked.
    flushSync(() => setPrintMode(mode));
    window.print();
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
        }
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

        @media (max-width: 640px) {
          .pk-page { padding: 20px 16px 44px !important; }
          .pk-header { flex-direction: column; align-items: stretch !important; gap: 16px !important; }
          .pk-gen { width: 100% !important; }
          .pk-filter-grid { flex-direction: column !important; }
          .pk-filter-grid > * { flex: 1 1 100% !important; min-width: 0 !important; }
          .pk-toggles { flex-direction: column !important; align-items: stretch !important; gap: 14px !important; }
          .pk-print-btns { width: 100%; flex-direction: column; }
          .pk-print-btns .btn { width: 100%; }
          .pk-resbar { flex-direction: column; align-items: stretch !important; gap: 14px; }
          .pk-chk { width: 20px !important; height: 20px !important; }
        }

        /* ── Print: hide the on-screen app, reveal the dedicated table
           layout. These are real <table> elements (not CSS grid) so the
           printed sheet pastes into Google Docs / Word as an actual editable
           table, and each <tr> repaginates whole. ────────────────────────── */
        @media print {
          .pk-app { display: none !important; }
          #pick-list-print {
            display: block !important;
            font-family: var(--font-body);
            font-size: 9pt;
            color: #201e1d;
          }

          /* Masthead — mirrors the on-screen header: vermilion eyebrow,
             heavy Archivo title, muted meta line, thick ink rule. */
          .ph { margin-bottom: 6mm; padding-bottom: 3mm; border-bottom: 2px solid #201e1d; }
          .ph-eyebrow { font-family: var(--font-heading); font-weight: 800; font-size: 7.5pt; letter-spacing: .12em; text-transform: uppercase; color: #ec3013; margin-bottom: 2mm; }
          .ph-title { font-family: var(--font-heading); font-weight: 800; font-size: 22pt; letter-spacing: -.015em; line-height: 1; margin: 0; color: #201e1d; }
          .ph-meta { font-size: 8pt; color: #605d5d; margin-top: 2.5mm; }

          /* Only the wrapper matching the active print mode is shown */
          .pg-wrap, .pt-wrap { display: none !important; }
          #pick-list-print[data-print-mode="manufacturing"] .pg-wrap { display: block !important; }
          #pick-list-print[data-print-mode="tracking"] .pt-wrap      { display: block !important; }

          /* ── Manufacturing list: 4 products per row on A4 portrait ── */
          table.pm { width:100%; border-collapse:collapse; table-layout:fixed; }
          .pm tr   { page-break-inside:avoid; break-inside:avoid; }
          .pm td   { width:25%; vertical-align:top; padding:2.5mm; border:1px solid #c9c7c6; }
          /* A short final row still renders 4 <td>; the empty ones have no
             children — hide their border so they read as blank space. */
          .pm td:empty { border:none; }
          .pc      { border:none; overflow:hidden; }
          .pc img  { width:100%; height:auto; display:block; }
          .pc-noimg { width:100%; height:22mm; background:#eae9e9; display:flex; align-items:center; justify-content:center; font-size:6pt; letter-spacing:.06em; text-transform:uppercase; color:#9b9797; }
          .pc-body { padding:2mm 0 0; }
          .pc-title { font-family:var(--font-heading); font-weight:800; font-size:8pt; line-height:1.2; margin-bottom:1.5mm; color:#201e1d; }
          .pc-vars { font-size:6.5pt; color:#7d7979; line-height:1.45; margin-bottom:2mm; }
          .pc-var-row { margin-bottom:.5mm; }
          .pc-vars b { color:#201e1d; }
          /* Card foot echoes the screen card: "TO PICK" label + vermilion total,
             separated by an ink rule. */
          .pc-qty  { display:flex; align-items:baseline; justify-content:space-between; gap:2mm; border-top:1.5px solid #201e1d; padding-top:1.5mm; font-family:var(--font-heading); font-weight:800; font-size:13pt; color:#ec3013; }
          .pc-qty::before { content:"To pick"; font-size:5.5pt; letter-spacing:.1em; text-transform:uppercase; color:#7d7979; }

          /* ── Tracking list: one row per product ───────────────────── */
          table.pt { width: 100%; border-collapse: collapse; table-layout: fixed; }
          /* Repeats the header row on every printed page */
          .pt thead { display: table-header-group; }
          /* Full grid: vertical separators divide the three columns
             (Image | Product & variants | Qty), horizontal ones divide rows.
             Header keeps the strong 2px ink underline. */
          .pt th { text-align:left; font-family:var(--font-body); font-size:7pt; font-weight:600; letter-spacing:.08em; text-transform:uppercase; color:#605d5d; padding:2mm 3mm; border:1px solid #c9c7c6; border-bottom:2px solid #201e1d; }
          .pt td { border:1px solid #c9c7c6; padding:2.5mm 3mm; vertical-align:middle; text-align:left; }
          .pt tbody tr { page-break-inside: avoid; break-inside: avoid; }
          .pt-col-img { width: 40mm; }
          .pt-col-qty { width: 24mm; text-align: center; }
          .pt-col-img img { width: 100%; height: auto; display: block; border:1px solid #c9c7c6; }
          .pt-noimg { width: 100%; height: 28mm; background: #eae9e9; display: flex; align-items: center; justify-content: center; font-size: 6pt; letter-spacing:.06em; text-transform:uppercase; color: #9b9797; }
          .pt-title { font-family:var(--font-heading); font-weight:800; font-size: 10pt; line-height: 1.25; margin-bottom: 1mm; color:#201e1d; }
          .pt-vars  { font-size: 7.5pt; color: #7d7979; line-height: 1.55; }
          .pt-var-row { margin-bottom: 0.5mm; }
          .pt-vars b { color:#201e1d; }
          .pt-qty { font-family:var(--font-heading); font-weight:800; text-align: center; font-size: 14pt; color:#ec3013; }
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
          <div className="ph-eyebrow">Unfulfilled orders · {today}</div>
          <div className="ph-title">Pick List</div>
          <div className="ph-meta">
            {printMode === "manufacturing" ? "Manufacturing list" : "Tracking list"}
            &nbsp;·&nbsp; Products: <b>{totalProducts}</b>
            &nbsp;·&nbsp; Items to pick: <b>{totalItems}</b>
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
                <div style={statLabel}>Items to pick</div>
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
              {selectedVariants.length > 0 && (
                <span className="tag tag-accent">
                  {selectedVariants.length} variant filter
                </span>
              )}
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
                      <div
                        role="listbox"
                        aria-multiselectable="true"
                        style={{
                          position: "absolute",
                          top: "100%",
                          left: 0,
                          right: 0,
                          zIndex: 30,
                          marginTop: "4px",
                          maxHeight: "250px",
                          overflowY: "auto",
                          background: "var(--color-bg)",
                          border: "1px solid var(--color-divider)",
                          boxShadow: "var(--shadow-lg)",
                          padding: "4px",
                        }}
                      >
                        {selectedVariants.length > 0 && (
                          <button
                            type="button"
                            onClick={() => setSelectedVariants([])}
                            style={{
                              width: "100%",
                              textAlign: "left",
                              padding: "8px 10px",
                              background: "transparent",
                              border: "none",
                              color: "var(--color-accent)",
                              fontFamily: "var(--font-heading)",
                              fontWeight: 800,
                              fontSize: "12px",
                              cursor: "pointer",
                            }}
                          >
                            Clear selection ({selectedVariants.length})
                          </button>
                        )}
                        {variantOptions.map((vt) => (
                          <label
                            key={vt}
                            role="option"
                            aria-selected={selectedVariants.includes(vt)}
                            style={{
                              display: "flex",
                              alignItems: "flex-start",
                              gap: "9px",
                              padding: "8px 10px",
                              fontSize: "14px",
                              cursor: "pointer",
                              color: "var(--color-text)",
                            }}
                          >
                            <input
                              type="checkbox"
                              className="pk-chk"
                              checked={selectedVariants.includes(vt)}
                              onChange={() => toggleVariant(vt)}
                              style={{ marginTop: "2px" }}
                            />
                            {/* Full variant name — wrap onto multiple lines
                                rather than clip, so nothing is hidden. */}
                            <span style={{ whiteSpace: "normal", overflowWrap: "anywhere", lineHeight: 1.35 }}>
                              {vt}
                            </span>
                          </label>
                        ))}
                      </div>
                    )}
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
                className="pk-noprint"
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
                className="pk-noprint"
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
