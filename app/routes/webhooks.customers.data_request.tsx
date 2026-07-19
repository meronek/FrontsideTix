import type { ActionFunctionArgs } from "react-router";

import { authenticate } from "../shopify.server";
import db from "../db.server";
import { getShopByDomain } from "../lib/shop.server";
import {
  buildWebhookDeliveryKey,
  reserveWebhookDelivery,
} from "../lib/webhooks";

// GDPR: customers/data_request — log the request for auditing/fulfillment.
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
  await db.privacyWebhookLog.create({
    data: { shopId: shop?.id, shopDomain, topic, payloadJson },
  });

  return new Response();
};
