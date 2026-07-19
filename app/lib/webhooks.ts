import crypto from "node:crypto";

import { Prisma, type PrismaClient } from "@prisma/client";

export function buildWebhookDeliveryKey(
  rawBody: string,
  eventId: string | null,
) {
  if (eventId) {
    return eventId;
  }

  return crypto.createHash("sha256").update(rawBody, "utf8").digest("hex");
}

export async function reserveWebhookDelivery(
  db: PrismaClient,
  input: {
    shopDomain: string;
    topic: string;
    deliveryKey: string;
  },
) {
  // SQLite's createMany has no skipDuplicates; rely on the unique constraint
  // (@@unique shopDomain+topic+deliveryKey) and treat P2002 as a duplicate.
  // This is also correct on Postgres after the production provider switch.
  try {
    await db.webhookDelivery.create({
      data: {
        shopDomain: input.shopDomain,
        topic: input.topic,
        deliveryKey: input.deliveryKey,
      },
    });
    return { duplicate: false };
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      return { duplicate: true };
    }
    throw error;
  }
}

export async function releaseWebhookDelivery(
  db: PrismaClient,
  input: {
    shopDomain: string;
    topic: string;
    deliveryKey: string;
  },
) {
  await db.webhookDelivery.deleteMany({
    where: {
      shopDomain: input.shopDomain,
      topic: input.topic,
      deliveryKey: input.deliveryKey,
    },
  });
}
