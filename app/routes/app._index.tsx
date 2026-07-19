import { useEffect } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useFetcher, useLoaderData, useSearchParams } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import db from "../db.server";
import { getOrCreateShop } from "../lib/shop.server";
import {
  centsToAmount,
  ensureDefaultBillingTiers,
  ensureShopCreditBalance,
  reconcilePendingBillingPurchases,
} from "../lib/billing";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = await getOrCreateShop(session.shop);

  await ensureDefaultBillingTiers();
  // Reconcile any pending one-time purchases (e.g. after returning from the
  // Shopify billing confirmation screen).
  try {
    await reconcilePendingBillingPurchases(shop.id, admin);
  } catch (error) {
    console.error("Unable to reconcile pending billing purchases", error);
  }

  const [tiers, balance] = await Promise.all([
    db.billingTier.findMany({
      where: { active: true },
      orderBy: [{ sortOrder: "asc" }, { ticketCredits: "asc" }],
      select: {
        id: true,
        code: true,
        name: true,
        ticketCredits: true,
        priceCents: true,
        currencyCode: true,
      },
    }),
    ensureShopCreditBalance(shop.id),
  ]);

  return {
    shopDomain: shop.shopDomain,
    tiers,
    balance: {
      freeCreditsRemaining: balance.freeCreditsRemaining,
      purchasedCreditsBalance: balance.purchasedCreditsBalance,
      totalCreditsAvailable:
        balance.freeCreditsRemaining + balance.purchasedCreditsBalance,
      lifetimePurchased: balance.lifetimePurchased,
      lifetimeConsumed: balance.lifetimeConsumed,
    },
  };
};

type PurchaseMutationResponse = {
  data?: {
    appPurchaseOneTimeCreate?: {
      confirmationUrl?: string;
      appPurchaseOneTime?: { id?: string; status?: string };
      userErrors?: Array<{ field?: string[]; message?: string }>;
    };
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = await getOrCreateShop(session.shop);

  const formData = await request.formData();
  const billingTierId = String(formData.get("billingTierId") ?? "");
  if (!billingTierId) {
    return { error: "Missing ticket pack" };
  }

  await ensureDefaultBillingTiers();
  const tier = await db.billingTier.findUnique({
    where: { id: billingTierId },
    select: {
      id: true,
      name: true,
      ticketCredits: true,
      priceCents: true,
      currencyCode: true,
      active: true,
    },
  });
  if (!tier || !tier.active) {
    return { error: "Invalid ticket pack" };
  }

  const returnBase = (process.env.SHOPIFY_APP_URL ?? "").replace(/\/$/, "");
  const mutation = `#graphql
    mutation CreateTicketPackPurchase(
      $name: String!
      $returnUrl: URL!
      $price: MoneyInput!
      $test: Boolean
    ) {
      appPurchaseOneTimeCreate(
        name: $name
        returnUrl: $returnUrl
        price: $price
        test: $test
      ) {
        confirmationUrl
        appPurchaseOneTime { id status }
        userErrors { field message }
      }
    }`;

  const response = await admin.graphql(mutation, {
    variables: {
      name: tier.name,
      returnUrl: `${returnBase}/app?billing=return`,
      price: {
        amount: centsToAmount(tier.priceCents),
        currencyCode: tier.currencyCode,
      },
      test: process.env.SHOPIFY_BILLING_TEST !== "false",
    },
  });
  const result = (await response.json()) as PurchaseMutationResponse;

  const payloadOut = result.data?.appPurchaseOneTimeCreate;
  const userError = payloadOut?.userErrors?.find((e) => e.message);
  if (userError?.message) {
    return { error: userError.message };
  }

  const confirmationUrl = payloadOut?.confirmationUrl;
  const shopifyChargeId = payloadOut?.appPurchaseOneTime?.id;
  if (!confirmationUrl || !shopifyChargeId) {
    return { error: "Unable to create billing confirmation URL" };
  }

  await db.billingPurchase.upsert({
    where: { shopifyChargeId },
    update: { status: payloadOut.appPurchaseOneTime?.status ?? "PENDING" },
    create: {
      shopId: shop.id,
      billingTierId: tier.id,
      shopifyChargeId,
      status: payloadOut.appPurchaseOneTime?.status ?? "PENDING",
    },
  });

  return { confirmationUrl };
};

function formatDollars(cents: number) {
  return (cents / 100).toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export default function AdminDashboard() {
  const { tiers, balance } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const [searchParams] = useSearchParams();

  const submittingTierId =
    fetcher.state !== "idle"
      ? String(fetcher.formData?.get("billingTierId") ?? "")
      : "";

  // Break out of the embedded iframe to the Shopify billing confirmation page.
  useEffect(() => {
    const url = fetcher.data && "confirmationUrl" in fetcher.data
      ? fetcher.data.confirmationUrl
      : undefined;
    if (url) {
      window.open(url, "_top");
    }
  }, [fetcher.data]);

  const purchaseError =
    fetcher.data && "error" in fetcher.data ? fetcher.data.error : null;
  const showBillingReturn = searchParams.get("billing") === "return";

  return (
    <s-page heading="Event Ticketing">
      {showBillingReturn ? (
        <s-banner tone="success" heading="Purchase processed">
          <s-paragraph>
            If your purchase was approved, the credits have been added to your
            balance below.
          </s-paragraph>
        </s-banner>
      ) : null}

      <s-section heading="Welcome to FrontsideTix">
        <s-paragraph>
          Thanks for installing. This is your hub for QR event ticketing —
          configure branding and ticket products, run check-in at the door, and
          review reports.
        </s-paragraph>
        <s-stack direction="inline" gap="base">
          <s-button href="/app/customize" variant="primary">
            Configure branding &amp; products
          </s-button>
          <s-button href="/app/check-in">Open check-in</s-button>
          <s-button href="/app/reports" variant="tertiary">
            View reports
          </s-button>
        </s-stack>
      </s-section>

      <s-section heading="Ticket credits">
        <s-paragraph>
          The free tier includes 50 ticket credits. Buy a pack any time and the
          credits are added to your purchased balance.
        </s-paragraph>
        <s-stack direction="block" gap="small-300">
          <s-text>
            <strong>Total available credits:</strong>{" "}
            {balance.totalCreditsAvailable}
          </s-text>
          <s-text>
            <strong>Free credits remaining:</strong>{" "}
            {balance.freeCreditsRemaining}
          </s-text>
          <s-text>
            <strong>Purchased credits balance:</strong>{" "}
            {balance.purchasedCreditsBalance}
          </s-text>
          <s-text>
            <strong>Lifetime purchased:</strong> {balance.lifetimePurchased}
          </s-text>
          <s-text>
            <strong>Lifetime consumed:</strong> {balance.lifetimeConsumed}
          </s-text>
        </s-stack>
      </s-section>

      {purchaseError ? (
        <s-banner tone="critical" heading="Purchase error">
          <s-paragraph>{purchaseError}</s-paragraph>
        </s-banner>
      ) : null}

      <s-section heading="Buy ticket packs">
        <s-grid
          gridTemplateColumns="1fr 1fr"
          gap="base"
        >
          {tiers.map((tier) => (
            <s-box
              key={tier.id}
              padding="base"
              borderWidth="base"
              borderRadius="base"
              background="subdued"
            >
              <s-stack direction="block" gap="small-200">
                <s-heading>{tier.name}</s-heading>
                <s-text>{tier.ticketCredits.toLocaleString()} credits</s-text>
                <s-text>
                  <strong>{formatDollars(tier.priceCents)}</strong>
                </s-text>
                <s-button
                  variant="primary"
                  onClick={() =>
                    fetcher.submit(
                      { billingTierId: tier.id },
                      { method: "POST" },
                    )
                  }
                  {...(submittingTierId === tier.id ? { loading: true } : {})}
                >
                  Buy ticket pack
                </s-button>
              </s-stack>
            </s-box>
          ))}
        </s-grid>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
