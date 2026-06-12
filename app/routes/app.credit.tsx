import type { HeadersFunction } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

export default function CreditPage() {
  const containerStyle: React.CSSProperties = {
    maxWidth: "800px",
    margin: "0 auto",
    padding: "60px 20px",
    fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
  };

  const cardStyle: React.CSSProperties = {
    background: "#ffffff",
    borderRadius: "24px",
    padding: "48px 32px",
    boxShadow: "0 20px 40px rgba(0,0,0,0.06), 0 1px 3px rgba(0,0,0,0.04)",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    textAlign: "center",
    position: "relative",
    overflow: "hidden",
    border: "1px solid rgba(0,0,0,0.05)",
  };

  const imageContainerStyle: React.CSSProperties = {
    width: "220px",
    height: "220px",
    borderRadius: "50%",
    overflow: "hidden",
    boxShadow: "0 12px 28px rgba(0,0,0,0.12)",
    marginBottom: "28px",
    border: "6px solid #ffffff",
    position: "relative",
    zIndex: 2,
    transition: "transform 0.3s ease-in-out",
  };

  const imageStyle: React.CSSProperties = {
    width: "100%",
    height: "100%",
    objectFit: "cover",
    objectPosition: "center 20%", // Adjust focus of the image slightly higher
  };

  const nameStyle: React.CSSProperties = {
    fontSize: "36px",
    fontWeight: "800",
    color: "#202223",
    marginBottom: "8px",
    letterSpacing: "-0.5px",
    zIndex: 2,
  };

  const roleStyle: React.CSSProperties = {
    fontSize: "16px",
    color: "#008060", // Shopify green accent
    fontWeight: "600",
    marginBottom: "24px",
    textTransform: "uppercase",
    letterSpacing: "1.5px",
    zIndex: 2,
  };

  const descStyle: React.CSSProperties = {
    fontSize: "17px",
    lineHeight: "1.6",
    color: "#6d7175",
    maxWidth: "560px",
    margin: "0 auto 36px",
    zIndex: 2,
  };

  const tagContainer: React.CSSProperties = {
    display: "flex",
    gap: "12px",
    flexWrap: "wrap",
    justifyContent: "center",
    marginBottom: "12px",
    zIndex: 2,
  };

  const tagStyle: React.CSSProperties = {
    padding: "8px 16px",
    backgroundColor: "rgba(0, 128, 96, 0.08)", // Light Shopify green background
    borderRadius: "20px",
    fontSize: "14px",
    fontWeight: "600",
    color: "#008060",
  };

  // Decorative background elements
  const bgDecoration1: React.CSSProperties = {
    position: "absolute",
    top: "-50px",
    left: "-50px",
    width: "250px",
    height: "250px",
    background: "linear-gradient(135deg, rgba(0,128,96,0.06), rgba(0,128,96,0))",
    borderRadius: "50%",
    zIndex: 1,
  };

  const bgDecoration2: React.CSSProperties = {
    position: "absolute",
    bottom: "-100px",
    right: "-80px",
    width: "400px",
    height: "400px",
    background: "linear-gradient(135deg, rgba(0,0,0,0.02), rgba(0,0,0,0))",
    borderRadius: "50%",
    zIndex: 1,
  };

  return (
    <>
      <style>{`
        .credit-image:hover {
          transform: scale(1.02);
        }
      `}</style>
      <s-page>
        <div style={containerStyle}>
          <div style={cardStyle}>
            <div style={bgDecoration1} />
            <div style={bgDecoration2} />
            
            <div style={imageContainerStyle} className="credit-image">
              <img 
                src="/credit-image.jpeg" 
                alt="Creator" 
                style={imageStyle} 
              />
            </div>
            
            <h1 style={nameStyle}>Arpon Samanta</h1>
            <div style={roleStyle}>Messiah</div>
            
            <p style={descStyle}>
              Built by Arpon Samanta. Turning fulfillment chaos into organized adventures since 2026. 📦✨
            </p>
            
            <div style={tagContainer}>
              <span style={tagStyle}>Created by: Arpon Samanta</span>
              <span style={tagStyle}>Bug Fixer: Arpon Samanta</span>
              <span style={tagStyle}>Deployed by: Arpon Samanta</span>
            </div>
            
          </div>
        </div>
      </s-page>
    </>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};