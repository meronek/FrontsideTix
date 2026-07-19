import type { ActionFunctionArgs } from "react-router";

import { authenticate } from "../shopify.server";
import db from "../db.server";
import { getShopByDomain } from "../lib/shop.server";
import {
  buildWebhookDeliveryKey,
  reserveWebhookDelivery,
} from "../lib/webhooks";

// GDPR: shop/redact — sent ~48h after uninstall. Purge all ticketing data for
// the shop (cascades to tickets, credits, ledger, etc.).
export const action = async ({ request }: ActionFunctionArgs) => {
  const eventId = request.headers.get("x-shopify-event-id");
  const { shop: shopDomain, topic, payload } =
    await authenticate.webhook(request);
  const payloadJson = JSON.stringify(payload ?? {});

  const reserve = await reserveWebhookDelivery(db, {
    shopDomain,
    topic,
    deliveryKey: buildWebhookDeliveryKey(payloadJson, eventId),
  });
  if (reserve.duplicate) {
    return new Response();
  }

  const shop = await getShopByDomain(shopDomain);

  // Log before deleting (PrivacyWebhookLog.shop relation is SetNull on delete).
  await db.privacyWebhookLog.create({
    data: { shopId: shop?.id, shopDomain, topic, payloadJson },
  });

  if (shop) {
    await db.shop.delete({ where: { id: shop.id } });
  }

  return new Response();
};
