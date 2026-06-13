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
 * Returns the original Shopify CDN URL without any modifications.
 * This preserves the original image quality and aspect ratio.
 */
function shopifyImg(url: string | undefined): string {
  if (!url) return "";
  return url;
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

        /* ── Mobile responsiveness for Shopify Mobile App ─────────── */
        /* Shopify Mobile WebView is typically 375-428px wide */
        @media (max-width: 428px) {
          /* Make filter inputs full width and larger for touch */
          input[type="date"], select {
            font-size: 16px !important;
            padding: 12px !important;
            min-height: 44px;
          }
          
          /* Larger checkboxes for touch */
          input[type="checkbox"] {
            width: 22px !important;
            height: 22px !important;
          }
          
          /* Stack filter form vertically */
          #filter-panel form {
            flex-direction: column !important;
            gap: 12px !important;
            padding: 16px !important;
          }
          
          /* Full-width filter fields */
          #filter-panel form > div {
            flex: 1 1 100% !important;
            min-width: 100% !important;
          }
          
          /* Stack action buttons full width */
          .filter-actions {
            flex-direction: column !important;
            width: 100% !important;
          }
          
          .filter-actions button,
          .filter-actions s-button {
            width: 100% !important;
          }
        }

        /* ── Screen: hide the print div ───────────────────────────── */
        @media screen {
          #pick-list-print { display: none !important; }
        }

        /* ── Print ────────────────────────────────────────────────── */
        /*
         * When window.print() fires:
         *   s-page            → hidden  (removes all Shopify Admin chrome)
         *   #pick-list-print  → shown   (our 3-column grid)
         *
         * Images are kept in their original quality and aspect ratio.
         * 3 cards per row provides clear, readable product information.
         */
        @media print {
          s-page            { display: none !important; }
          #pick-list-print  {
            display: block !important;
            font-family: Arial, sans-serif;
            font-size: 9pt;
            color: #000;
          }

          .ph               { margin-bottom: 5mm; }
          .ph-title         { font-size: 14pt; font-weight: bold; margin: 0 0 2mm; }
          .ph-meta          { font-size: 8pt; color: #444; margin: 0; }

          /* 3 cards per row on A4 portrait */
          .pg {
            display: grid;
            grid-template-columns: repeat(3, 1fr);
            gap: 4mm;
          }

          .pc {
            border: 1px solid #ccc;
            border-radius: 4px;
            overflow: hidden;
            page-break-inside: avoid;
            break-inside: avoid;
          }
          .pc img {
            width: 100%;
            height: auto;
            display: block;
          }
          .pc-noimg {
            width: 100%;
            height: 30mm;
            background: #f0f0f0;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 7pt;
            color: #888;
          }
          .pc-body  { padding: 2mm 3mm; }
          .pc-title {
            font-size: 8pt; font-weight: bold; line-height: 1.3;
            margin-bottom: 1.5mm;
          }
          .pc-vars  { font-size: 7pt; color: #555; line-height: 1.4; margin-bottom: 1.5mm; }
          .pc-qty   {
            background: #fffacd;
            text-align: center;
            font-size: 12pt; font-weight: bold;
            padding: 1.5mm; border-radius: 3px;
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
                  /* Original image URL - no resizing, no cropping */
                  src={shopifyImg(product.productImage.url)}
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
      {/* App UI (hidden at print time via @media print { s-page: none })     */}
      {/* ──────────────────────────────────────────────────────────────────── */}
      <s-page>
        {/* ── Hero ────────────────────────────────────────────────────── */}
        <div
          style={{
            textAlign: "center",
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
              fontSize: "clamp(22px, 5vw, 36px)",
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
              fontSize: "clamp(13px, 2.5vw, 16px)",
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
          id="filter-panel"
          style={{
            maxHeight: showFilters ? "1000px" : "0px",
            opacity: showFilters ? 1 : 0,
            overflow: "hidden",
            transition: "all 300ms ease-in-out",
            marginBottom: showFilters ? "24px" : "0px",
          }}
        >
          <form onSubmit={submitPickList} style={filterContent}>
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
              className="filter-actions"
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
                      src={shopifyImg(product.productImage?.url)}
                      alt={product.productImage?.altText || product.productTitle}
                      style={{
                        width: "100%",
                        height: "200px",
                        objectFit: "contain",
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