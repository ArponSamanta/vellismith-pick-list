import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";

export const action = async ({ request }: ActionFunctionArgs) => {
    try {
        const { payload, session, topic, shop } = await authenticate.webhook(request);
        console.log(`Received ${topic} webhook for ${shop}`);

        const current = payload.current as string[];
        if (session && current && Array.isArray(current)) {
            await db.session.update({
                where: {
                    id: session.id
                },
                data: {
                    scope: current.join(","),
                },
            });
        }
        return new Response(null, { status: 200 });
    } catch (error) {
        console.error("Error handling scopes_update webhook:", error);
        return new Response(JSON.stringify({ error: "Internal Server Error" }), {
            status: 500,
            headers: { "Content-Type": "application/json" }
        });
    }
};
