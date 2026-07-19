import type { ActionFunctionArgs } from "react-router";

import { authenticate } from "../shopify.server";
import db from "../db.server";
import { getOrCreateShop } from "../lib/shop.server";
import { sendOrderTicketEmail } from "../lib/email";
import {
  buildWebhookDeliveryKey,
  releaseWebhookDelivery,
  reserveWebhookDelivery,
} from "../lib/webhooks";
import {
  createQrCodeDataUrl,
  generateHardToGuessTicketId,
} from "../lib/tickets";

type ShopifyOrderPayload = {
  id: number | string;
  name?: string;
  email?: string;
  contact_email?: string;
  customer?: { email?: string };
  line_items?: Array<{
    product_id?: number | string | null;
    name?: string;
    title?: string;
    variant_title?: string | null;
    quantity?: number;
  }>;
};

function resolveOrderEmail(order: ShopifyOrderPayload) {
  return (
    order.email?.trim() ||
    order.contact_email?.trim() ||
    order.customer?.email?.trim() ||
    null
  );
}

const METAFIELDS_SET_MUTATION = `#graphql
  mutation OrderTicketMetafield($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      userErrors { field message }
    }
  }`;

export const action = async ({ request }: ActionFunctionArgs) => {
  const eventId = request.headers.get("x-shopify-event-id");
  const { shop: shopDomain, topic, payload, admin } =
    await authenticate.webhook(request);

  const order = payload as ShopifyOrderPayload;
  const deliveryKey = buildWebhookDeliveryKey(JSON.stringify(payload), eventId);

  const reserve = await reserveWebhookDelivery(db, {
    shopDomain,
    topic,
    deliveryKey,
  });
  if (reserve.duplicate) {
    return new Response();
  }

  try {
    const shopRecord = await getOrCreateShop(shopDomain);
    const orderId = String(order.id);
    const orderEmail = resolveOrderEmail(order);
    const lineItems = order.line_items ?? [];

    // Only generate tickets when the order contains a configured ticket product.
    // If none are configured, every order generates a ticket (legacy behavior).
    const selectedProductIds = (
      await db.shopTicketProduct.findMany({
        where: { shopId: shopRecord.id },
        select: { productId: true },
      })
    ).map((row) => row.productId);

    if (selectedProductIds.length > 0) {
      const selectedSet = new Set(selectedProductIds);
      const hasTicketProduct = lineItems.some(
        (item) =>
          item.product_id !== null &&
          item.product_id !== undefined &&
          selectedSet.has(String(item.product_id)),
      );
      if (!hasTicketProduct) {
        return new Response();
      }
    }

    const ticketSelect = {
      id: true,
      shopId: true,
      orderId: true,
      orderName: true,
      customerEmail: true,
      ticketId: true,
      qrCodeDataUrl: true,
    } as const;

    let orderTicket = await db.orderTicket.findUnique({
      where: { shopId_orderId: { shopId: shopRecord.id, orderId } },
      select: ticketSelect,
    });

    if (!orderTicket) {
      const ticketId = generateHardToGuessTicketId();
      const qrCodeDataUrl = await createQrCodeDataUrl(ticketId, shopDomain);
      orderTicket = await db.orderTicket.create({
        data: {
          shopId: shopRecord.id,
          orderId,
          orderName: order.name,
          customerEmail: orderEmail,
          ticketId,
          qrCodeDataUrl,
        },
        select: ticketSelect,
      });
    } else if (
      orderTicket.orderName !== (order.name ?? null) ||
      orderTicket.customerEmail !== orderEmail
    ) {
      orderTicket = await db.orderTicket.update({
        where: { id: orderTicket.id },
        data: { orderName: order.name, customerEmail: orderEmail },
        select: ticketSelect,
      });
    }

    // Best-effort: tag the Shopify order with the ticket id for later retrieval.
    if (admin) {
      try {
        await admin.graphql(METAFIELDS_SET_MUTATION, {
          variables: {
            metafields: [
              {
                ownerId: `gid://shopify/Order/${orderId}`,
                namespace: "event_ticketing",
                key: "ticket_id",
                type: "single_line_text_field",
                value: orderTicket.ticketId,
              },
            ],
          },
        });
      } catch (error) {
        console.error("Failed to set order ticket metafield", {
          shopDomain,
          orderId,
          error,
        });
      }
    }

    if (orderEmail) {
      try {
        const emailResult = await sendOrderTicketEmail({
          to: orderEmail,
          orderName: order.name,
          orderId,
          lineItems,
          qrCodeDataUrl: orderTicket.qrCodeDataUrl,
          ticketId: orderTicket.ticketId,
          logoUrl: shopRecord.emailLogoUrl,
        });
        if (!emailResult.sent) {
          console.warn("Order ticket email skipped", emailResult.reason, orderEmail);
        }
      } catch (error) {
        console.error("Failed to send order ticket email", error);
      }
    }

    return new Response();
  } catch (error) {
    await releaseWebhookDelivery(db, { shopDomain, topic, deliveryKey }).catch(
      (releaseError) =>
        console.error("Failed to release webhook reservation", releaseError),
    );
    console.error("orders/create webhook failed", error);
    return new Response("Webhook processing failed", { status: 500 });
  }
};
