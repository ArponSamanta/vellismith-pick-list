import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Outlet, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";

import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);

  // eslint-disable-next-line no-undef
  return { apiKey: process.env.SHOPIFY_API_KEY || "" };
};

export default function App() {
  const { apiKey } = useLoaderData<typeof loader>();

  return (
    <AppProvider embedded apiKey={apiKey}>
      {/* rel="home" tells App Bridge which route is the app's home. Without
          it, App Bridge doesn't recognise the other entries as valid
          destinations and silently bounces the click back to home — which
          looks exactly like the nav link doing nothing. The home entry is
          hidden from the rendered menu; Shopify links the app title to it. */}
      <s-app-nav>
        {/* eslint-disable-next-line @typescript-eslint/no-explicit-any --
            `rel` is documented on s-link and is present in
            @shopify/app-bridge-types' BaseElementAttributes, but the Polaris
            web-component React types that JSX resolves for <s-link> omit it.
            Spread so the attribute still reaches the DOM. */}
        <s-link href="/app" {...({ rel: "home" } as any)}>
          Home
        </s-link>
        <s-link href="/app/track">Track</s-link>
        <s-link href="/app/credit">Credit</s-link>
      </s-app-nav>
      <Outlet />
    </AppProvider>
  );
}

// Shopify needs React Router to catch some thrown responses, so that their headers are included in the response.
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
