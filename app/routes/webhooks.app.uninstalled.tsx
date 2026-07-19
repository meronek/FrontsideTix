import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, session, topic, payload } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  // Webhook requests can trigger multiple times and after an app has already been uninstalled.
  // If this webhook already ran, the session may have been deleted previously.
  if (session) {
    await db.session.deleteMany({ where: { shop } });
  }

  // Audit-log the uninstall. Ticketing data (tickets, credits, history) is
  // intentionally preserved here so a reinstall keeps it; it is only purged on
  // the shop/redact GDPR webhook ~48h later.
  try {
    const shopRow = await db.shop.findUnique({
      where: { shopDomain: shop },
      select: { id: true },
    });
    await db.privacyWebhookLog.create({
      data: {
        shopId: shopRow?.id,
        shopDomain: shop,
        topic: String(topic),
        payloadJson: JSON.stringify(payload ?? {}),
      },
    });
  } catch (error) {
    console.error("Failed to log app/uninstalled", error);
  }

  return new Response();
};
