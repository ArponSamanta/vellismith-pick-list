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

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return null;
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin } = await authenticate.admin(request);

  const { generatePickList, formatPickListAsText, filterByDateRange, filterByProductName } = await import("../utils/picklist.server");

  try {
    const formData = await request.formData();
    const startDate = formData.get("startDate") as string | null;
    const endDate = formData.get("endDate") as string | null;
    const searchKeyword = formData.get("searchKeyword") as string | null;

    let pickList = await generatePickList(admin);

    if (startDate || endDate) {
      pickList = filterByDateRange(pickList, startDate || undefined, endDate || undefined);
    }

    if (searchKeyword) {
      pickList = filterByProductName(pickList, searchKeyword);
    }

    const formattedText = formatPickListAsText(pickList);

    return {
      pickList,
      formattedText,
      success: true,
    };
  } catch (error) {
    console.error("Error generating pick list:", error);
    if (error instanceof Error) {
      console.error("Error message:", error.message);
      console.error("Error stack:", error.stack);
    }
    return {
      success: false,
      error: `Failed to generate pick list: ${error instanceof Error ? error.message : 'Unknown error'}`,
    };
  }
};

export default function Index() {
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();

  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [searchKeyword, setSearchKeyword] = useState("");
  const [showFilters, setShowFilters] = useState(false);

  const isLoading =
    ["loading", "submitting"].includes(fetcher.state) &&
    fetcher.formMethod === "POST";

  const totalProducts = fetcher.data?.pickList?.length || 0;
  const totalItems = fetcher.data?.pickList?.reduce((sum: number, p: any) => sum + p.totalQuantity, 0) || 0;

  const generatePickList = (e: React.FormEvent) => {
    e.preventDefault();
    const formData = new FormData();
    if (startDate) formData.append("startDate", startDate);
    if (endDate) formData.append("endDate", endDate);
    if (searchKeyword) formData.append("searchKeyword", searchKeyword);
    fetcher.submit(formData, { method: "POST" });
  };

  const clearFilters = () => {
    setStartDate("");
    setEndDate("");
    setSearchKeyword("");
  };

  const handlePrint = () => {
    if (!fetcher.data?.pickList) return;

    const printWindow = window.open("", "_blank");
    if (!printWindow) return;

    const gridHTML = fetcher.data.pickList
      .map(
        (product: any) => `
        <div style="border: 1px solid #ddd; border-radius: 8px; padding: 12px; margin-bottom: 16px; page-break-inside: avoid;">
          <img src="${product.productImage?.url || ''}" alt="${product.productImage?.altText || product.productTitle}"
               style="width: 100%; height: 150px; object-fit: cover; border-radius: 4px; margin-bottom: 8px;" />
          <div style="font-weight: bold; margin-bottom: 8px; font-size: 13px;">${product.productTitle}</div>
          <div style="font-size: 0.85em; margin-bottom: 4px; line-height: 1.3;">
            ${product.variants.map((v: any) => `${v.variantTitle}${v.sku ? ' (' + v.sku + ')' : ''}: ${v.quantity}`).join("<br />")}
          </div>
          <div style="background: #fffacd; padding: 8px; border-radius: 4px; font-size: 16px; font-weight: bold; text-align: center;">
            ${product.totalQuantity}
          </div>
        </div>
      `
      )
      .join("");

    printWindow.document.write(`
      <!DOCTYPE html>
      <html>
        <head>
          <title>Pick List - Unfulfilled Orders</title>
          <style>
            * {
              margin: 0;
              padding: 0;
              box-sizing: border-box;
            }
            body {
              font-family: Arial, sans-serif;
              padding: 10mm;
              background: white;
            }
            h1 {
              font-size: 24px;
              margin-bottom: 8px;
            }
            p {
              margin-bottom: 20px;
              color: #666;
            }
            .grid {
              display: grid;
              grid-template-columns: repeat(4, 1fr);
              gap: 12px;
            }
            @page {
              size: A4;
              margin: 10mm;
            }
            @media print {
              body {
                padding: 8mm;
              }
              .grid {
                grid-template-columns: repeat(4, 1fr);
                gap: 10px;
              }
            }
            @media print and (max-width: 1200px) {
              .grid {
                grid-template-columns: repeat(3, 1fr);
              }
            }
          </style>
        </head>
        <body>
          <h1>Pick List - Unfulfilled Orders</h1>
          <p>Date: ${new Date().toLocaleDateString()}</p>
          <div class="grid">
            ${gridHTML}
          </div>
        </body>
      </html>
    `);
    printWindow.document.close();
    setTimeout(() => {
      printWindow.print();
    }, 500);
  };

  useEffect(() => {
    if (fetcher.data?.success) {
      shopify.toast.show("Pick list generated successfully");
    } else if (fetcher.data?.success === false) {
      shopify.toast.show("Failed to generate pick list", { isError: true });
    }
  }, [fetcher.data?.success, shopify]);

  const heroStyles: React.CSSProperties = {
    textAlign: "center",
    padding: "60px 20px 40px",
    background: "linear-gradient(135deg, var(--s-color-bg) 0%, var(--s-color-bg-subdued) 100%)",
    borderRadius: "0 0 16px 16px",
    marginBottom: "40px",
    animation: "fadeIn 0.6s ease-out",
  };

  const heroTitle: React.CSSProperties = {
    fontSize: "36px",
    fontWeight: "bold",
    marginBottom: "12px",
    color: "var(--s-color-text)",
    letterSpacing: "-0.5px",
  };

  const heroSubtitle: React.CSSProperties = {
    fontSize: "16px",
    opacity: 0.7,
    marginBottom: "32px",
    color: "var(--s-color-text-subdued)",
  };

  const mainButton: React.CSSProperties = {
    padding: "18px 48px",
    fontSize: "18px",
    fontWeight: "bold",
    minWidth: "240px",
    cursor: isLoading ? "not-allowed" : "pointer",
    transition: "all 200ms ease-in-out",
  };

  const statsContainer: React.CSSProperties = {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
    gap: "16px",
    marginTop: "32px",
    justifyContent: "center",
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

  const statNumber: React.CSSProperties = {
    fontSize: "28px",
    fontWeight: "bold",
    color: "var(--s-color-interactive)",
    marginBottom: "8px",
  };

  const statLabel: React.CSSProperties = {
    fontSize: "12px",
    textTransform: "uppercase",
    letterSpacing: "0.5px",
    opacity: 0.6,
  };

  const filterToggle: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    padding: "12px 16px",
    backgroundColor: "transparent",
    border: "none",
    cursor: "pointer",
    fontSize: "15px",
    fontWeight: "600",
    color: "var(--s-color-text)",
    transition: "all 200ms ease-in-out",
    marginBottom: "0px",
    marginTop: "24px",
  };

  const filterPanel: React.CSSProperties = {
    maxHeight: showFilters ? "500px" : "0px",
    opacity: showFilters ? 1 : 0,
    overflow: "hidden",
    transition: "all 300ms ease-in-out",
    marginBottom: showFilters ? "24px" : "0px",
  };

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

  const arrowIcon: React.CSSProperties = {
    display: "inline-block",
    transition: "transform 300ms ease-in-out",
    transform: showFilters ? "rotate(180deg)" : "rotate(0deg)",
  };

  return (
    <>
      <style>{`
        @keyframes fadeIn {
          from { opacity: 0; transform: translateY(10px); }
          to { opacity: 1; transform: translateY(0); }
        }

        @keyframes slideDown {
          from {
            max-height: 0;
            opacity: 0;
            transform: translateY(-10px);
          }
          to {
            max-height: 500px;
            opacity: 1;
            transform: translateY(0);
          }
        }

        button {
          font-family: inherit;
          border: none;
          border-radius: 6px;
          cursor: pointer;
        }

        s-button:not([disabled]):hover {
          filter: brightness(1.05);
        }

        input[type="date"] {
          padding: 8px 12px;
          border: 1px solid var(--s-color-border);
          border-radius: 6px;
          font-size: 14px;
          font-family: inherit;
          transition: all 200ms ease-in-out;
          background-color: var(--s-color-bg);
        }

        input[type="date"]:focus {
          outline: none;
          border-color: var(--s-color-interactive);
          box-shadow: 0 0 0 3px rgba(0, 0, 0, 0.1);
        }

        input[type="date"]:hover {
          border-color: var(--s-color-interactive-hover);
        }
      `}</style>

      <s-page>
        {/* Hero Section */}
        <div style={heroStyles}>
          <div style={heroTitle}>📦 Pick List Generator</div>
          <div style={heroSubtitle}>
            Generate and manage your unfulfilled orders with ease
          </div>

          <form onSubmit={generatePickList}>
            <s-button
              type="submit"
              slot="primary-action"
              {...(isLoading ? { loading: true, disabled: true } : {})}
            >
              {isLoading ? "Generating..." : "Generate Pick List"}
            </s-button>
          </form>

          {/* Stats Display */}
          {fetcher.data?.success && (
            <div style={statsContainer}>
              <div style={statCard}>
                <div style={statNumber}>{totalProducts}</div>
                <div style={statLabel}>Products</div>
              </div>
              <div style={statCard}>
                <div style={statNumber}>{totalItems}</div>
                <div style={statLabel}>Total Items</div>
              </div>
            </div>
          )}
        </div>

        {/* Filter Toggle */}
        <button
          onClick={() => setShowFilters(!showFilters)}
          style={filterToggle}
          onMouseEnter={(e) => {
            (e.currentTarget as HTMLElement).style.opacity = "0.7";
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLElement).style.opacity = "1";
          }}
        >
          <span style={arrowIcon}>▼</span>
          Advanced Filters
        </button>

        {/* Filter Panel */}
        <div style={filterPanel}>
          <form onSubmit={generatePickList} style={filterContent}>
            <div>
              <label style={{ display: "block", marginBottom: "6px", fontSize: "13px", fontWeight: "600" }}>
                Start Date
              </label>
              <input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
              />
            </div>
            <div>
              <label style={{ display: "block", marginBottom: "6px", fontSize: "13px", fontWeight: "600" }}>
                End Date
              </label>
              <input
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
              />
            </div>
            <div style={{ flex: 1, minWidth: "200px" }}>
              <s-text-field
                label="Search Product"
                placeholder="Enter keyword..."
                value={searchKeyword}
                onChange={(e: any) => setSearchKeyword(e.target.value)}
              />
            </div>
            <div style={{ display: "flex", gap: "8px" }}>
              <s-button
                type="submit"
                {...(isLoading ? { loading: true, disabled: true } : {})}
              >
                {isLoading ? "Applying..." : "Apply"}
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

        {/* Results Section */}
        {fetcher.data?.success && fetcher.data?.pickList && (
          <>
            <div style={{ marginBottom: "24px", marginTop: "32px" }}>
              <s-button
                onClick={handlePrint}
                variant="tertiary"
              >
                🖨️ Print Pick List
              </s-button>
            </div>

            <s-section heading="Products to Pick">
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
                  gap: "16px",
                  animation: "fadeIn 0.4s ease-out",
                }}
              >
                {fetcher.data.pickList.map((product: any) => (
                  <div
                    key={product.productId}
                    style={{
                      border: "1px solid var(--s-color-border)",
                      borderRadius: "12px",
                      overflow: "hidden",
                      padding: 0,
                      transition: "all 200ms ease-in-out",
                      cursor: "pointer",
                      backgroundColor: "var(--s-color-bg)",
                    }}
                    onMouseEnter={(e) => {
                      (e.currentTarget as HTMLElement).style.boxShadow = "0 8px 24px rgba(0, 0, 0, 0.12)";
                      (e.currentTarget as HTMLElement).style.transform = "translateY(-4px)";
                    }}
                    onMouseLeave={(e) => {
                      (e.currentTarget as HTMLElement).style.boxShadow = "none";
                      (e.currentTarget as HTMLElement).style.transform = "translateY(0)";
                    }}
                  >
                    <img
                      src={product.productImage?.url || ""}
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

                      <div style={{ fontSize: "0.85em", marginBottom: "12px", opacity: 0.7, lineHeight: "1.4" }}>
                        {product.variants.map((variant: any, idx: number) => (
                          <div key={idx}>
                            {variant.variantTitle}
                            {variant.sku && ` (${variant.sku})`}: <strong>{variant.quantity}</strong>
                          </div>
                        ))}
                      </div>

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

        {/* Error State */}
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