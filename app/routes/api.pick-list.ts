import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { generatePickList, formatPickListAsText } from "../utils/picklist.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin } = await authenticate.admin(request);

  try {
    const pickList = await generatePickList(admin);
    const formattedText = formatPickListAsText(pickList);

    return {
      pickList,
      formattedText,
      success: true,
    };
  } catch (error) {
    console.error("Error generating pick list:", error);
    return {
      success: false,
      error: "Failed to generate pick list. Please try again.",
    };
  }
};