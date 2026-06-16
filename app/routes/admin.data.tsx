import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import db from "../db.server";

// ─── Auth ────────────────────────────────────────────────────────────────
// Cross-shop data, so it can't ride Shopify's authenticate.admin(). It gets
// its own lightweight gate: HTTP Basic Auth backed by two env vars.

function requireAdminAuth(request: Request) {
  const expectedUser = process.env.ADMIN_DATA_USER;
  const expectedPass = process.env.ADMIN_DATA_PASSWORD;

  if (!expectedUser || !expectedPass) {
    throw new Response("Set ADMIN_DATA_USER and ADMIN_DATA_PASSWORD", { status: 500 });
  }

  // Check query params instead of Authorization header
  const url = new URL(request.url);
  const user = url.searchParams.get("user");
  const pass = url.searchParams.get("pass");

  if (user === expectedUser && pass === expectedPass) return;

  throw new Response("Unauthorized", { status: 401 });
}

function maskToken(token: string | null | undefined) {
  if (!token) return "—";
  if (token.length <= 10) return "••••••••";
  return `${token.slice(0, 6)}…${token.slice(-4)}`;
}

// ─── Server ──────────────────────────────────────────────────────────────

export async function loader({ request }: LoaderFunctionArgs) {
  requireAdminAuth(request);

  const sessions = await db.session.findMany({
    orderBy: [{ shop: "asc" }, { isOnline: "asc" }],
  });

  return {
    count: sessions.length,
    sessions: sessions.map((s) => ({
      id: s.id,
      shop: s.shop,
      isOnline: s.isOnline,
      scope: s.scope,
      expires: s.expires,
      accessToken: maskToken(s.accessToken),
      email: s.email ?? null,
    })),
  };
}

// ─── Component ───────────────────────────────────────────────────────────

export default function AdminDataViewer() {
  const { sessions, count } = useLoaderData<typeof loader>();

  return (
    <div style={{ fontFamily: "system-ui, sans-serif", padding: "32px", maxWidth: 1100, margin: "0 auto" }}>
      <h1 style={{ marginBottom: 4, fontSize: "20px" }}>Sessions ({count})</h1>
      <p style={{ color: "#666", marginBottom: 24, fontSize: "14px" }}>
        Read-only view of every Shopify session stored in the database.
      </p>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "14px" }}>
        <thead>
          <tr style={{ textAlign: "left", borderBottom: "2px solid #ddd" }}>
            <th style={{ padding: "8px" }}>Shop</th>
            <th style={{ padding: "8px" }}>Online</th>
            <th style={{ padding: "8px" }}>Scope</th>
            <th style={{ padding: "8px" }}>Expires</th>
            <th style={{ padding: "8px" }}>Access Token</th>
            <th style={{ padding: "8px" }}>Email</th>
          </tr>
        </thead>
        <tbody>
          {sessions.map((s) => (
            <tr key={s.id} style={{ borderBottom: "1px solid #eee" }}>
              <td style={{ padding: "8px" }}>{s.shop}</td>
              <td style={{ padding: "8px" }}>{s.isOnline ? "Yes" : "No"}</td>
              <td style={{ padding: "8px" }}>{s.scope || "—"}</td>
              <td style={{ padding: "8px" }}>
                {s.expires ? new Date(s.expires).toLocaleString() : "—"}
              </td>
              <td style={{ padding: "8px", fontFamily: "monospace" }}>{s.accessToken}</td>
              <td style={{ padding: "8px" }}>{s.email || "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}