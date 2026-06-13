import { useEffect, useState } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useFetcher } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";

// ─── Server ──────────────────────────────────────────────────────────────────

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return null;
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const { generatePickList, formatPickListAsText, filterByProductName } =
    await import("../utils/picklist.server");

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

    return { pickList, formattedText, success: true };
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
 * Append Shopify CDN resize query params so the browser fetches a
 * smaller image.  This is the key fix for oversized print PDFs.
 *
 * Works on any shopify.com/cdn URL. Falls back silently on other URLs.
 */
function shopifyImg(url: string | undefined, width: number): string {
  if (!url) return "";
  try {
    const u = new URL(url);
    u.searchParams.set("width", String(width));
    u.searchParams.set("height", String(width));
    u.searchParams.set("crop", "center");
    return u.toString();
  } catch {
    return url ?? "";
  }
}

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
  const [showFilters, setShowFilters] = useState(false);

  const isLoading =
    ["loading", "submitting"].includes(fetcher.state) &&
    fetcher.formMethod === "POST";

  const pickList: any[] = fetcher.data?.pickList ?? [];
  const totalProducts = pickList.length;
  const totalItems = pickList.reduce(
    (sum: number, p: any) => sum + p.totalQuantity,
    0
  );

  const submitPickList = (e: React.FormEvent) => {
    e.preventDefault();
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
  };

  /**
   * PRINT FIX
   * ─────────
   * The previous approach used `window.open("", "_blank")` + `document.write`.
   * Browsers block `window.open` calls made from inside an iframe (which is how
   * Shopify embeds apps) even when triggered by a user gesture. The new popup
   * never opens, `printWindow` is null, and the function exits silently.
   *
   * Fix: keep a hidden `#pick-list-print` div in the same DOM that React
   * updates reactively.  `handlePrint` just calls `window.print()`.
   * A `@media print` CSS rule swaps visibility:
   *   • `s-page`           → hidden
   *   • `#pick-list-print` → visible
   *
   * Images in the print div use 100 px Shopify CDN thumbnails (vs. full-res)
   * which shrinks a 50-product PDF from ~80 MB → ~500 KB.
   */
  const handlePrint = () => {
    if (!pickList.length) return;
    window.print();
  };

  useEffect(() => {
    if (fetcher.data?.success) {
      shopify.toast.show("Pick list generated successfully");
    } else if (fetcher.data?.success === false) {
      shopify.toast.show("Failed to generate pick list", { isError: true });
    }
  }, [fetcher.data?.success, shopify]);

  // ── Shared styles ─────────────────────────────────────────────────────────

  const filterContent: React.CSSProperties = {
    display: "flex",
    gap: "12px",
    padding: "20px",
    backgroundColor: "var(--s-color-bg-subdued)",
    borderRadius: "12px",
    flexWrap: "wrap",
    alignItems: "flex-end",
    border: "1px solid var(--s-color-border-subdued)",
  };

  /** Each filter field: grows/shrinks but never goes below min-width */
  const fieldWrapper = (minW = 140): React.CSSProperties => ({
    flex: `1 1 ${minW}px`,
    minWidth: `${minW}px`,
  });

  const labelStyle: React.CSSProperties = {
    display: "block",
    marginBottom: "6px",
    fontSize: "13px",
    fontWeight: "600",
  };

  const selectStyle: React.CSSProperties = {
    padding: "8px 12px",
    border: "1px solid var(--s-color-border)",
    borderRadius: "6px",
    fontSize: "14px",
    fontFamily: "inherit",
    backgroundColor: "var(--s-color-bg)",
    color: "var(--s-color-text)",
    cursor: "pointer",
    width: "100%",
    boxSizing: "border-box",
    transition: "border-color 200ms, box-shadow 200ms",
  };

  const checkboxLabel: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    fontSize: "14px",
    fontWeight: "500",
    cursor: "pointer",
    userSelect: "none",
    color: "var(--s-color-text)",
  };

  const statsContainer: React.CSSProperties = {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
    gap: "16px",
    maxWidth: "400px",
    margin: "32px auto 0",
  };

  const statCard: React.CSSProperties = {
    padding: "20px",
    backgroundColor: "var(--s-color-bg-subdued)",
    borderRadius: "12px",
    textAlign: "center",
    border: "1px solid var(--s-color-border-subdued)",
    transition: "all 200ms ease-in-out",
  };

  return (
    <>
      {/* ──────────────────────────────────────────────────────────────────── */}
      {/* Global styles                                                        */}
      {/* ──────────────────────────────────────────────────────────────────── */}
      <style>{`
        @keyframes fadeIn {
          from { opacity: 0; transform: translateY(10px); }
          to   { opacity: 1; transform: translateY(0); }
        }

        /* ── Common form controls ─────────────────────────────────── */
        button { font-family: inherit; border: none; border-radius: 6px; cursor: pointer; }
        s-button:not([disabled]):hover { filter: brightness(1.05); }

        input[type="date"], select {
          box-sizing: border-box;
          width: 100%;
          padding: 8px 12px;
          border: 1px solid var(--s-color-border);
          border-radius: 6px;
          font-size: 14px;
          font-family: inherit;
          background-color: var(--s-color-bg);
          color: var(--s-color-text);
          transition: border-color 200ms, box-shadow 200ms;
        }
        input[type="date"]:hover, select:hover  { border-color: var(--s-color-interactive-hover); }
        input[type="date"]:focus, select:focus   {
          outline: none;
          border-color: var(--s-color-interactive);
          box-shadow: 0 0 0 3px rgba(0,0,0,0.1);
        }
        input[type="checkbox"] {
          width: 16px; height: 16px;
          cursor: pointer;
          accent-color: var(--s-color-interactive);
          flex-shrink: 0;
        }

        /* ── Screen: hide the print div ───────────────────────────── */
        @media screen {
          #pick-list-print { display: none !important; }
        }

        /* ── Print ────────────────────────────────────────────────── */
        /*
         * When window.print() fires:
         *   s-page            → hidden  (removes all Shopify Admin chrome)
         *   #pick-list-print  → shown   (our compact 5-column grid)
         *
         * Images in the print div use 100px Shopify CDN thumbnails.
         * This is what drops the PDF size from 50-100 MB down to ~500 KB.
         */
        @media print {
          s-page            { display: none !important; }
          #pick-list-print  {
            display: block !important;
            font-family: Arial, sans-serif;
            font-size: 8pt;
            color: #000;
          }

          .ph               { margin-bottom: 5mm; }
          .ph-title         { font-size: 13pt; font-weight: bold; margin: 0 0 1.5mm; }
          .ph-meta          { font-size: 7.5pt; color: #444; margin: 0; }

          /* 5 cards per row on A4 portrait */
          .pg {
            display: grid;
            grid-template-columns: repeat(5, 1fr);
            gap: 3.5mm;
          }

          .pc {
            border: 1px solid #ccc;
            border-radius: 3px;
            overflow: hidden;
            page-break-inside: avoid;
            break-inside: avoid;
          }
          .pc img {
            width: 100%;
            height: 16mm;        /* small fixed height = tiny file size */
            object-fit: cover;
            display: block;
          }
          .pc-noimg {
            width: 100%;
            height: 16mm;
            background: #f0f0f0;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 6pt;
            color: #888;
          }
          .pc-body  { padding: 1.5mm 2mm; }
          .pc-title {
            font-size: 7pt; font-weight: bold; line-height: 1.25;
            margin-bottom: 1mm;
            display: -webkit-box;
            -webkit-line-clamp: 2;
            -webkit-box-orient: vertical;
            overflow: hidden;
          }
          .pc-vars  { font-size: 6pt; color: #555; line-height: 1.3; margin-bottom: 1mm; }
          .pc-qty   {
            background: #fffacd;
            text-align: center;
            font-size: 11pt; font-weight: bold;
            padding: 1mm; border-radius: 2px;
          }
        }

        @page { size: A4 portrait; margin: 10mm; }
      `}</style>

      {/* ──────────────────────────────────────────────────────────────────── */}
      {/* Hidden print section                                                 */}
      {/* Lives in the DOM at all times; React keeps it up-to-date.           */}
      {/* Made visible only via @media print (see CSS above).                 */}
      {/* ──────────────────────────────────────────────────────────────────── */}
      <div id="pick-list-print">
        <div className="ph">
          <div className="ph-title">📦 Pick List — Unfulfilled Orders</div>
          <div className="ph-meta">
            {new Date().toLocaleDateString("en-IN", {
              day: "2-digit",
              month: "short",
              year: "numeric",
            })}
            &nbsp;·&nbsp; Products: <b>{totalProducts}</b>
            &nbsp;·&nbsp; Total items: <b>{totalItems}</b>
          </div>
        </div>

        <div className="pg">
          {pickList.map((product: any) => (
            <div className="pc" key={product.productId}>
              {product.productImage?.url ? (
                <img
                  /* 100 px thumbnail → ~4 KB each vs. ~1 MB full-res */
                  src={shopifyImg(product.productImage.url, 100)}
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
                      <div key={i}>
                        {v.variantTitle}
                        {showSku && v.sku ? ` (${v.sku})` : ""}: <b>{v.quantity}</b>
                      </div>
                    ))}
                  </div>
                )}
                <div className="pc-qty">{product.totalQuantity}</div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* ──────────────────────────────────────────────────────────────────── */}
      {/* App UI (hidden at print time via  @media print { s-page: none })    */}
      {/* ──────────────────────────────────────────────────────────────────── */}
      <s-page>
        {/* ── Hero ────────────────────────────────────────────────────── */}
        <div
          style={{
            textAlign: "center",
            /*
             * RESPONSIVE FIX: clamp() gives fluid sizing instead of
             * one hardcoded value that overflows on small screens.
             */
            padding: "clamp(28px, 6vw, 60px) 20px clamp(20px, 4vw, 40px)",
            background:
              "linear-gradient(135deg, var(--s-color-bg) 0%, var(--s-color-bg-subdued) 100%)",
            borderRadius: "0 0 16px 16px",
            marginBottom: "40px",
            animation: "fadeIn 0.6s ease-out",
          }}
        >
          <div
            style={{
              fontSize: "clamp(22px, 5vw, 36px)", // was hardcoded 36px
              fontWeight: "bold",
              marginBottom: "12px",
              color: "var(--s-color-text)",
              letterSpacing: "-0.5px",
            }}
          >
            📦 Pick List Generator
          </div>
          <div
            style={{
              fontSize: "clamp(13px, 2.5vw, 16px)", // was hardcoded 16px
              opacity: 0.7,
              marginBottom: "32px",
              color: "var(--s-color-text-subdued)",
            }}
          >
            Generate and manage your unfulfilled orders with ease
          </div>

          <form onSubmit={submitPickList}>
            <s-button
              type="submit"
              {...(isLoading ? { loading: true, disabled: true } : {})}
            >
              {isLoading ? "Generating…" : "Generate Pick List"}
            </s-button>
          </form>

          {fetcher.data?.success && (
            <div style={statsContainer}>
              <div style={statCard}>
                <div
                  style={{
                    fontSize: "28px",
                    fontWeight: "bold",
                    color: "var(--s-color-interactive)",
                    marginBottom: "8px",
                  }}
                >
                  {totalProducts}
                </div>
                <div
                  style={{
                    fontSize: "12px",
                    textTransform: "uppercase",
                    letterSpacing: "0.5px",
                    opacity: 0.6,
                  }}
                >
                  Products
                </div>
              </div>
              <div style={statCard}>
                <div
                  style={{
                    fontSize: "28px",
                    fontWeight: "bold",
                    color: "var(--s-color-interactive)",
                    marginBottom: "8px",
                  }}
                >
                  {totalItems}
                </div>
                <div
                  style={{
                    fontSize: "12px",
                    textTransform: "uppercase",
                    letterSpacing: "0.5px",
                    opacity: 0.6,
                  }}
                >
                  Total Items
                </div>
              </div>
            </div>
          )}
        </div>

        {/* ── Filter toggle ────────────────────────────────────────── */}
        <button
          onClick={() => setShowFilters((v) => !v)}
          style={{
            display: "flex",
            alignItems: "center",
            gap: "8px",
            padding: "12px 16px",
            background: "transparent",
            border: "none",
            cursor: "pointer",
            fontSize: "15px",
            fontWeight: "600",
            color: "var(--s-color-text)",
            marginTop: "24px",
          }}
          onMouseEnter={(e) => {
            (e.currentTarget as HTMLElement).style.opacity = "0.7";
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLElement).style.opacity = "1";
          }}
        >
          <span
            style={{
              display: "inline-block",
              transition: "transform 300ms ease-in-out",
              transform: showFilters ? "rotate(180deg)" : "rotate(0deg)",
            }}
          >
            ▼
          </span>
          Advanced Filters
        </button>

        {/* ── Filter panel ─────────────────────────────────────────── */}
        <div
          style={{
            /*
             * RESPONSIVE FIX: was 600px which could clip the panel when
             * flex children stack vertically on narrow viewports.
             */
            maxHeight: showFilters ? "1000px" : "0px",
            opacity: showFilters ? 1 : 0,
            overflow: "hidden",
            transition: "all 300ms ease-in-out",
            marginBottom: showFilters ? "24px" : "0px",
          }}
        >
          <form onSubmit={submitPickList} style={filterContent}>
            {/* RESPONSIVE FIX: all field wrappers now have flex: "1 1 Xpx"   */}
            {/* so they grow to fill the row and wrap to a new line on mobile. */}

            {/* Start Date */}
            <div style={fieldWrapper(140)}>
              <label style={labelStyle}>Start Date</label>
              <input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
              />
            </div>

            {/* End Date */}
            <div style={fieldWrapper(140)}>
              <label style={labelStyle}>End Date</label>
              <input
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
              />
            </div>

            {/* Search */}
            <div style={fieldWrapper(200)}>
              <s-text-field
                label="Search Product"
                placeholder="Enter keyword…"
                value={searchKeyword}
                onChange={(e: any) => setSearchKeyword(e.target.value)}
              />
            </div>

            {/* Sort */}
            <div style={fieldWrapper(180)}>
              <label style={labelStyle}>Sort By</label>
              <select
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value)}
                style={selectStyle}
              >
                <option value="alpha">Alphabetical (A–Z)</option>
                <option value="old-to-new">Old to New</option>
                <option value="new-to-old">New to Old</option>
                <option value="qty-high-to-low">Highest Qty → Lowest</option>
                <option value="qty-low-to-high">Lowest Qty → Highest</option>
              </select>
            </div>

            {/* Display options */}
            <div
              style={{
                display: "flex",
                gap: "20px",
                flexWrap: "wrap",
                width: "100%",
                borderTop: "1px solid var(--s-color-border-subdued)",
                paddingTop: "16px",
                marginTop: "4px",
              }}
            >
              <label style={checkboxLabel}>
                <input
                  type="checkbox"
                  checked={showSku}
                  onChange={(e) => setShowSku(e.target.checked)}
                />
                Include SKU
              </label>
              <label style={checkboxLabel}>
                <input
                  type="checkbox"
                  checked={showVariantQuantity}
                  onChange={(e) => setShowVariantQuantity(e.target.checked)}
                />
                Include Individual Variant Quantity
              </label>
            </div>

            {/* Action buttons */}
            <div
              style={{
                display: "flex",
                gap: "8px",
                width: "100%",
                flexWrap: "wrap",
              }}
            >
              <s-button
                type="submit"
                {...(isLoading ? { loading: true, disabled: true } : {})}
              >
                {isLoading ? "Applying…" : "Apply"}
              </s-button>
              <s-button
                type="button"
                variant="secondary"
                onClick={clearFilters}
                {...(isLoading ? { disabled: true } : {})}
              >
                Clear
              </s-button>
            </div>
          </form>
        </div>

        {/* ── Results ─────────────────────────────────────────────── */}
        {fetcher.data?.success && pickList.length > 0 && (
          <>
            <div style={{ marginBottom: "24px", marginTop: "32px" }}>
              <s-button onClick={handlePrint} variant="tertiary">
                🖨️ Print Pick List
              </s-button>
            </div>

            <s-section heading="Products to Pick">
              <div
                style={{
                  display: "grid",
                  /*
                   * RESPONSIVE FIX: `min(220px, 100%)` prevents the column
                   * from being wider than the viewport on very narrow screens.
                   */
                  gridTemplateColumns:
                    "repeat(auto-fill, minmax(min(220px, 100%), 1fr))",
                  gap: "16px",
                  animation: "fadeIn 0.4s ease-out",
                }}
              >
                {pickList.map((product: any) => (
                  <div
                    key={product.productId}
                    style={{
                      border: "1px solid var(--s-color-border)",
                      borderRadius: "12px",
                      overflow: "hidden",
                      transition: "box-shadow 200ms ease-in-out, transform 200ms ease-in-out",
                      backgroundColor: "var(--s-color-bg)",
                    }}
                    onMouseEnter={(e) => {
                      const el = e.currentTarget as HTMLElement;
                      el.style.boxShadow = "0 8px 24px rgba(0,0,0,0.12)";
                      el.style.transform = "translateY(-4px)";
                    }}
                    onMouseLeave={(e) => {
                      const el = e.currentTarget as HTMLElement;
                      el.style.boxShadow = "none";
                      el.style.transform = "translateY(0)";
                    }}
                  >
                    <img
                      /*
                       * 440 px is enough for 2× retina on a ~220 px card.
                       * Still much smaller than the original full-res CDN URL.
                       */
                      src={shopifyImg(product.productImage?.url, 440)}
                      alt={product.productImage?.altText || product.productTitle}
                      style={{
                        width: "100%",
                        height: "200px",
                        objectFit: "cover",
                        display: "block",
                        backgroundColor: "var(--s-color-bg-subdued)",
                      }}
                    />
                    <div style={{ padding: "12px" }}>
                      <div
                        style={{
                          fontWeight: "bold",
                          marginBottom: "8px",
                          fontSize: "14px",
                          lineHeight: "1.4",
                          minHeight: "28px",
                        }}
                      >
                        {product.productTitle}
                      </div>

                      {showVariantQuantity && (
                        <div
                          style={{
                            fontSize: "0.85em",
                            marginBottom: "12px",
                            opacity: 0.7,
                            lineHeight: "1.4",
                          }}
                        >
                          {product.variants.map((variant: any, idx: number) => (
                            <div key={idx}>
                              {variant.variantTitle}
                              {showSku && variant.sku && ` (${variant.sku})`}:{" "}
                              <strong>{variant.quantity}</strong>
                            </div>
                          ))}
                        </div>
                      )}

                      {!showVariantQuantity && showSku && (
                        <div
                          style={{
                            fontSize: "0.85em",
                            marginBottom: "12px",
                            opacity: 0.7,
                            lineHeight: "1.4",
                          }}
                        >
                          {product.variants.map((variant: any, idx: number) =>
                            variant.sku ? (
                              <div key={idx}>SKU: {variant.sku}</div>
                            ) : null
                          )}
                        </div>
                      )}

                      <div
                        style={{
                          backgroundColor: "var(--s-color-bg-warning)",
                          padding: "12px",
                          borderRadius: "8px",
                          fontSize: "18px",
                          fontWeight: "bold",
                          textAlign: "center",
                          color: "var(--s-color-text)",
                        }}
                      >
                        {product.totalQuantity}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </s-section>
          </>
        )}

        {/* ── Empty state ──────────────────────────────────────────── */}
        {fetcher.data?.success && pickList.length === 0 && (
          <div
            style={{
              textAlign: "center",
              padding: "48px 20px",
              opacity: 0.6,
              animation: "fadeIn 0.3s ease-out",
            }}
          >
            <div style={{ fontSize: "48px", marginBottom: "16px" }}>📭</div>
            <div style={{ fontSize: "18px", fontWeight: "600" }}>
              No products to pick
            </div>
            <div style={{ fontSize: "14px", marginTop: "8px" }}>
              All orders are fulfilled, or no orders match your filters.
            </div>
          </div>
        )}

        {/* ── Error state ──────────────────────────────────────────── */}
        {fetcher.data?.success === false && (
          <div
            style={{
              padding: "16px",
              backgroundColor: "var(--s-color-bg-critical)",
              borderRadius: "8px",
              marginTop: "16px",
              animation: "fadeIn 0.3s ease-out",
            }}
          >
            <s-paragraph>
              {fetcher.data.error || "An error occurred. Please try again."}
            </s-paragraph>
          </div>
        )}
      </s-page>
    </>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
