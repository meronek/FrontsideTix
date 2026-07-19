import { Prisma } from "@prisma/client";

import db from "../db.server";

// Minimal structural type for the template's `admin.graphql` client so this lib
// stays decoupled from the Shopify SDK import surface.
type AdminGraphqlClient = {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<Response>;
};

const DEFAULT_FREE_TICKET_CREDITS = 50;

export const DEFAULT_BILLING_TIERS = [
  {
    code: "PACK_100",
    name: "100 Tickets",
    ticketCredits: 100,
    priceCents: 1000,
    currencyCode: "USD",
    sortOrder: 100,
  },
  {
    code: "PACK_500",
    name: "500 Tickets",
    ticketCredits: 500,
    priceCents: 4000,
    currencyCode: "USD",
    sortOrder: 200,
  },
  {
    code: "PACK_1000",
    name: "1000 Tickets",
    ticketCredits: 1000,
    priceCents: 8500,
    currencyCode: "USD",
    sortOrder: 300,
  },
  {
    code: "PACK_5000",
    name: "5000 Tickets",
    ticketCredits: 5000,
    priceCents: 30000,
    currencyCode: "USD",
    sortOrder: 400,
  },
] as const;

export async function ensureDefaultBillingTiers() {
  const count = await db.billingTier.count();
  if (count > 0) {
    return;
  }

  // Guarded by the count check above, so no duplicates to skip.
  // (SQLite's createMany does not support skipDuplicates.)
  await db.billingTier.createMany({
    data: DEFAULT_BILLING_TIERS.map((tier) => ({ ...tier })),
  });
}

export async function ensureShopCreditBalance(shopId: string) {
  return db.shopCreditBalance.upsert({
    where: { shopId },
    update: {},
    create: {
      shopId,
      freeCreditsRemaining: DEFAULT_FREE_TICKET_CREDITS,
      purchasedCreditsBalance: 0,
      lifetimePurchased: 0,
      lifetimeConsumed: 0,
    },
  });
}

export async function consumeTicketCreditInTx(
  tx: Prisma.TransactionClient,
  shopId: string,
  note: string = "Customer checked in",
) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const balance = await tx.shopCreditBalance.upsert({
      where: { shopId },
      update: {},
      create: {
        shopId,
        freeCreditsRemaining: DEFAULT_FREE_TICKET_CREDITS,
        purchasedCreditsBalance: 0,
        lifetimePurchased: 0,
        lifetimeConsumed: 0,
      },
    });

    if (balance.freeCreditsRemaining > 0) {
      const updated = await tx.shopCreditBalance.updateMany({
        where: {
          shopId,
          freeCreditsRemaining: balance.freeCreditsRemaining,
          purchasedCreditsBalance: balance.purchasedCreditsBalance,
        },
        data: {
          freeCreditsRemaining: { decrement: 1 },
          lifetimeConsumed: { increment: 1 },
        },
      });

      if (updated.count === 1) {
        await tx.shopCreditLedger.create({
          data: {
            shopId,
            type: "CONSUMPTION",
            creditsDelta: -1,
            note,
          },
        });

        return { consumed: true, source: "FREE" as const };
      }

      continue;
    }

    if (balance.purchasedCreditsBalance > 0) {
      const updated = await tx.shopCreditBalance.updateMany({
        where: {
          shopId,
          freeCreditsRemaining: balance.freeCreditsRemaining,
          purchasedCreditsBalance: balance.purchasedCreditsBalance,
        },
        data: {
          purchasedCreditsBalance: { decrement: 1 },
          lifetimeConsumed: { increment: 1 },
        },
      });

      if (updated.count === 1) {
        await tx.shopCreditLedger.create({
          data: {
            shopId,
            type: "CONSUMPTION",
            creditsDelta: -1,
            note,
          },
        });

        return { consumed: true, source: "PURCHASED" as const };
      }

      continue;
    }

    return { consumed: false, source: null };
  }

  throw new Error("Unable to reserve ticket credit due to concurrent updates");
}

export async function consumeTicketCredit(shopId: string) {
  return db.$transaction((tx) => consumeTicketCreditInTx(tx, shopId));
}

export async function grantPurchasedCredits(params: {
  shopId: string;
  billingTierId: string;
  shopifyChargeId: string;
  ticketCredits: number;
  amountCents: number;
  currencyCode: string;
  note?: string;
}) {
  return db.$transaction(async (tx) => {
    const existing = await tx.shopCreditLedger.findUnique({
      where: { externalChargeId: params.shopifyChargeId },
      select: { id: true },
    });

    if (existing) {
      return { granted: false };
    }

    await tx.shopCreditBalance.upsert({
      where: { shopId: params.shopId },
      update: {
        purchasedCreditsBalance: { increment: params.ticketCredits },
        lifetimePurchased: { increment: params.ticketCredits },
      },
      create: {
        shopId: params.shopId,
        freeCreditsRemaining: DEFAULT_FREE_TICKET_CREDITS,
        purchasedCreditsBalance: params.ticketCredits,
        lifetimePurchased: params.ticketCredits,
        lifetimeConsumed: 0,
      },
    });

    await tx.shopCreditLedger.create({
      data: {
        shopId: params.shopId,
        billingTierId: params.billingTierId,
        type: "PURCHASE",
        creditsDelta: params.ticketCredits,
        amountCents: params.amountCents,
        currencyCode: params.currencyCode,
        externalChargeId: params.shopifyChargeId,
        note: params.note,
      },
    });

    return { granted: true };
  });
}

type PurchaseStatusResponse = {
  data?: {
    node?: {
      id?: string;
      status?: string;
    } | null;
  };
  errors?: Array<{ message?: string }>;
};

// Rewired for the React Router template: takes the authenticated `admin` GraphQL
// client instead of looking up a stored access token.
export async function reconcilePendingBillingPurchases(
  shopId: string,
  admin: AdminGraphqlClient,
) {
  const pending = await db.billingPurchase.findMany({
    where: {
      shopId,
      status: { in: ["PENDING", "ACCEPTED"] },
      creditedAt: null,
    },
    include: {
      billingTier: true,
    },
    orderBy: { createdAt: "asc" },
  });

  if (pending.length === 0) return;

  for (const purchase of pending) {
    const query = `#graphql
      query PurchaseStatus($id: ID!) {
        node(id: $id) {
          ... on AppPurchaseOneTime {
            id
            status
          }
        }
      }
    `;

    const response = await admin.graphql(query, {
      variables: { id: purchase.shopifyChargeId },
    });
    const result = (await response.json()) as PurchaseStatusResponse;

    if (result.errors?.length) {
      continue;
    }

    const status = result.data?.node?.status?.toUpperCase();
    if (!status) {
      continue;
    }

    if (status === "ACTIVE" || status === "ACCEPTED") {
      await grantPurchasedCredits({
        shopId: purchase.shopId,
        billingTierId: purchase.billingTierId,
        shopifyChargeId: purchase.shopifyChargeId,
        ticketCredits: purchase.billingTier.ticketCredits,
        amountCents: purchase.billingTier.priceCents,
        currencyCode: purchase.billingTier.currencyCode,
        note: `Purchase ${purchase.billingTier.name} approved`,
      });

      await db.billingPurchase.update({
        where: { id: purchase.id },
        data: {
          status,
          creditedAt: new Date(),
        },
      });

      continue;
    }

    if (["DECLINED", "EXPIRED", "CANCELLED"].includes(status)) {
      await db.billingPurchase.update({
        where: { id: purchase.id },
        data: { status },
      });
    }
  }
}

export function centsToAmount(cents: number) {
  return (cents / 100).toFixed(2);
}
