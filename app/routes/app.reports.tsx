import { useMemo, useState } from "react";
import type {
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { Form, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import db from "../db.server";
import { getOrCreateShop } from "../lib/shop.server";
import {
  fetchRecentOrders,
  fetchTicketProducts,
} from "../lib/shopify-data.server";

type RangePreset = "7d" | "30d" | "90d" | "all" | "custom";

function resolveDateRange(request: Request) {
  const url = new URL(request.url);
  const presetRaw = (url.searchParams.get("range") ?? "30d").toLowerCase();
  const preset: RangePreset =
    presetRaw === "7d" ||
    presetRaw === "30d" ||
    presetRaw === "90d" ||
    presetRaw === "all" ||
    presetRaw === "custom"
      ? (presetRaw as RangePreset)
      : "30d";

  const now = new Date();

  if (preset === "all") {
    return { preset, start: null as Date | null, end: null as Date | null };
  }

  if (preset === "custom") {
    const startRaw = url.searchParams.get("start") ?? "";
    const endRaw = url.searchParams.get("end") ?? "";
    if (startRaw && endRaw) {
      const start = new Date(`${startRaw}T00:00:00.000Z`);
      const end = new Date(`${endRaw}T23:59:59.999Z`);
      if (
        !Number.isNaN(start.getTime()) &&
        !Number.isNaN(end.getTime()) &&
        start.getTime() <= end.getTime()
      ) {
        return { preset, start, end };
      }
    }
  }

  const days = preset === "7d" ? 7 : preset === "90d" ? 90 : 30;
  const start = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  return { preset: preset === "custom" ? "30d" : preset, start, end: now };
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = await getOrCreateShop(session.shop);

  const selectedProductIds = (
    await db.shopTicketProduct.findMany({
      where: { shopId: shop.id },
      select: { productId: true },
      orderBy: { createdAt: "asc" },
    })
  ).map((row) => row.productId);

  const range = resolveDateRange(request);

  const [products, allOrders] = await Promise.all([
    fetchTicketProducts(admin, selectedProductIds),
    fetchRecentOrders(admin, 250),
  ]);

  const orders = allOrders.filter((order) => {
    if (!range.start || !range.end) return true;
    if (!order.created_at) return false;
    const parsed = new Date(order.created_at);
    if (Number.isNaN(parsed.getTime())) return false;
    return (
      parsed.getTime() >= range.start.getTime() &&
      parsed.getTime() <= range.end.getTime()
    );
  });

  // Customer email comes from the DB (captured at webhook time), not GraphQL.
  const emailByOrderId = new Map(
    (
      await db.orderTicket.findMany({
        where: {
          shopId: shop.id,
          orderId: {
            in: orders
              .map((o) => o.id)
              .filter((id): id is string => Boolean(id)),
          },
        },
        select: { orderId: true, customerEmail: true },
      })
    ).map((t) => [t.orderId, t.customerEmail]),
  );

  const selectedSet = new Set(selectedProductIds);
  const filterToSelected = selectedProductIds.length > 0;

  const productStats = new Map<
    string,
    {
      productId: string;
      title: string;
      status: string;
      quantityPurchased: number;
      ordersCount: number;
      lastPurchasedAt: string | null;
    }
  >();

  for (const product of products) {
    productStats.set(product.id, {
      productId: product.id,
      title: product.title,
      status: product.status,
      quantityPurchased: 0,
      ordersCount: 0,
      lastPurchasedAt: null,
    });
  }

  let totalMatchedQuantity = 0;
  let totalMatchedOrders = 0;
  const revenueByCurrency = new Map<string, number>();

  const recentPurchases = orders
    .map((order) => {
      const lineItems = order.line_items ?? [];
      const matchedLineItems = lineItems.filter((item) => {
        if (item.product_id === null || item.product_id === undefined) {
          return !filterToSelected;
        }
        if (!filterToSelected) return true;
        return selectedSet.has(String(item.product_id));
      });

      if (matchedLineItems.length === 0) return null;

      const matchedQuantity = matchedLineItems.reduce(
        (sum, item) => sum + (item.quantity ?? 0),
        0,
      );

      let matchedRevenueAmount = 0;
      const orderCurrency = order.currency ?? "USD";

      for (const item of matchedLineItems) {
        const id =
          item.product_id === null || item.product_id === undefined
            ? `unknown:${item.title ?? "Unknown"}`
            : String(item.product_id);

        if (!productStats.has(id)) {
          productStats.set(id, {
            productId: id,
            title: item.title ?? "Unknown product",
            status: "unknown",
            quantityPurchased: 0,
            ordersCount: 0,
            lastPurchasedAt: null,
          });
        }

        const stat = productStats.get(id);
        if (!stat) continue;

        stat.quantityPurchased += item.quantity ?? 0;
        stat.ordersCount += 1;

        const unitPrice = Number(item.price ?? "0");
        const lineQuantity = item.quantity ?? 0;
        const lineAmount = Number.isNaN(unitPrice)
          ? 0
          : unitPrice * lineQuantity;
        matchedRevenueAmount += lineAmount;

        if (order.created_at) {
          if (!stat.lastPurchasedAt || order.created_at > stat.lastPurchasedAt) {
            stat.lastPurchasedAt = order.created_at;
          }
        }
      }

      totalMatchedQuantity += matchedQuantity;
      totalMatchedOrders += 1;
      revenueByCurrency.set(
        orderCurrency,
        (revenueByCurrency.get(orderCurrency) ?? 0) + matchedRevenueAmount,
      );

      return {
        orderId: order.id ? String(order.id) : null,
        orderName: order.name ?? "Unknown",
        purchasedAt: order.created_at ?? null,
        customerEmail: order.id
          ? emailByOrderId.get(String(order.id)) ?? null
          : null,
        totalPrice: order.total_price ?? null,
        currency: order.currency ?? null,
        matchedQuantity,
        matchedRevenue: matchedRevenueAmount,
        matchedProducts: matchedLineItems.map((item) => ({
          productId:
            item.product_id === null || item.product_id === undefined
              ? null
              : String(item.product_id),
          title: item.title ?? "Unknown product",
          quantity: item.quantity ?? 0,
          unitPrice: item.price ?? null,
          lineAmount: Number(item.price ?? "0") * (item.quantity ?? 0),
        })),
      };
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item))
    .sort((a, b) => {
      const aTime = a.purchasedAt ? new Date(a.purchasedAt).getTime() : 0;
      const bTime = b.purchasedAt ? new Date(b.purchasedAt).getTime() : 0;
      return bTime - aTime;
    })
    .slice(0, 25);

  const productSummary = [...productStats.values()]
    .filter((row) => row.quantityPurchased > 0 || !filterToSelected)
    .sort((a, b) => {
      if (b.quantityPurchased !== a.quantityPurchased) {
        return b.quantityPurchased - a.quantityPurchased;
      }
      return a.title.localeCompare(b.title);
    });

  return {
    mode: filterToSelected
      ? ("SELECTED_PRODUCTS" as const)
      : ("ALL_PRODUCTS" as const),
    selectedProductCount: selectedProductIds.length,
    appliedRange: {
      preset: range.preset as RangePreset,
      start: range.start?.toISOString() ?? null,
      end: range.end?.toISOString() ?? null,
    },
    summary: {
      totalMatchedQuantity,
      totalMatchedOrders,
      totalProductsShown: productSummary.length,
      matchedRevenueByCurrency: [...revenueByCurrency.entries()].map(
        ([currency, amount]) => ({ currency, amount }),
      ),
    },
    products: productSummary,
    recentPurchases,
  };
};

function formatDate(value: string | null) {
  if (!value) return "-";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString();
}

function formatMoney(value: string | null, currency: string | null) {
  if (!value) return "-";
  const amount = Number(value);
  if (Number.isNaN(amount)) return value;
  return amount.toLocaleString(undefined, {
    style: "currency",
    currency: currency || "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function asCsvCell(value: string | number | null | undefined) {
  const raw = value === null || value === undefined ? "" : String(value);
  return `"${raw.replace(/"/g, '""')}"`;
}

function downloadCsv(
  filename: string,
  rows: Array<Array<string | number | null | undefined>>,
) {
  const text = rows
    .map((row) => row.map((cell) => asCsvCell(cell)).join(","))
    .join("\n");
  const blob = new Blob([text], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export default function ReportsPage() {
  const report = useLoaderData<typeof loader>();
  const [rangePreset, setRangePreset] = useState<RangePreset>(
    report.appliedRange.preset,
  );

  const revenueSummaryText = useMemo(() => {
    if (!report.summary.matchedRevenueByCurrency.length) return "-";
    return report.summary.matchedRevenueByCurrency
      .map((item) =>
        item.amount.toLocaleString(undefined, {
          style: "currency",
          currency: item.currency,
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        }),
      )
      .join(" + ");
  }, [report]);

  const modeText =
    report.mode === "SELECTED_PRODUCTS"
      ? `Showing selected ticket products (${report.selectedProductCount}).`
      : "No ticket products are selected, so this report includes all products.";

  const handleExportProductCsv = () => {
    downloadCsv("ticket-report-products.csv", [
      ["Product", "Status", "Quantity Purchased", "Orders", "Last Purchase"],
      ...report.products.map((p) => [
        p.title,
        p.status,
        p.quantityPurchased,
        p.ordersCount,
        formatDate(p.lastPurchasedAt),
      ]),
    ]);
  };

  const handleExportPurchasesCsv = () => {
    downloadCsv("ticket-report-recent-purchases.csv", [
      [
        "Order",
        "Purchased At",
        "Customer Email",
        "Matched Quantity",
        "Matched Revenue",
        "Currency",
        "Matched Products",
      ],
      ...report.recentPurchases.map((purchase) => [
        purchase.orderName,
        formatDate(purchase.purchasedAt),
        purchase.customerEmail ?? "",
        purchase.matchedQuantity,
        purchase.matchedRevenue.toFixed(2),
        purchase.currency ?? "USD",
        purchase.matchedProducts
          .map((p) => `${p.title} x${p.quantity}`)
          .join("; "),
      ]),
    ]);
  };

  return (
    <s-page heading="Ticket reports">
      <s-section heading="Overview">
        <s-paragraph>{modeText}</s-paragraph>

        <Form method="get">
          <s-stack direction="inline" gap="base" alignItems="end">
            <s-select
              name="range"
              label="Date range"
              value={rangePreset}
              onChange={(event: Event) =>
                setRangePreset(
                  (event.currentTarget as HTMLSelectElement)
                    .value as RangePreset,
                )
              }
            >
              <s-option value="7d">Last 7 days</s-option>
              <s-option value="30d">Last 30 days</s-option>
              <s-option value="90d">Last 90 days</s-option>
              <s-option value="all">All time</s-option>
              <s-option value="custom">Custom range</s-option>
            </s-select>
            {rangePreset === "custom" ? (
              <>
                <label style={{ display: "grid", gap: "4px", fontSize: "13px" }}>
                  Start date
                  <input type="date" name="start" />
                </label>
                <label style={{ display: "grid", gap: "4px", fontSize: "13px" }}>
                  End date
                  <input type="date" name="end" />
                </label>
              </>
            ) : null}
            <s-button type="submit">Apply</s-button>
          </s-stack>
        </Form>

        <s-stack direction="inline" gap="base">
          <s-button onClick={handleExportProductCsv}>
            Export product CSV
          </s-button>
          <s-button onClick={handleExportPurchasesCsv}>
            Export purchases CSV
          </s-button>
        </s-stack>

        <s-grid gridTemplateColumns="1fr 1fr 1fr 1fr" gap="base">
          <s-box padding="base" borderWidth="base" borderRadius="base">
            <s-text>Quantity purchased</s-text>
            <s-heading>
              {report.summary.totalMatchedQuantity.toLocaleString()}
            </s-heading>
          </s-box>
          <s-box padding="base" borderWidth="base" borderRadius="base">
            <s-text>Orders with ticket items</s-text>
            <s-heading>
              {report.summary.totalMatchedOrders.toLocaleString()}
            </s-heading>
          </s-box>
          <s-box padding="base" borderWidth="base" borderRadius="base">
            <s-text>Products in report</s-text>
            <s-heading>
              {report.summary.totalProductsShown.toLocaleString()}
            </s-heading>
          </s-box>
          <s-box padding="base" borderWidth="base" borderRadius="base">
            <s-text>Matched revenue</s-text>
            <s-heading>{revenueSummaryText}</s-heading>
          </s-box>
        </s-grid>
      </s-section>

      <s-section heading="Product quantity breakdown">
        {report.products.length === 0 ? (
          <s-paragraph>
            No purchases matched the current report filter.
          </s-paragraph>
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header>Product</s-table-header>
              <s-table-header>Quantity</s-table-header>
              <s-table-header>Orders</s-table-header>
              <s-table-header>Last purchase</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {report.products.map((product) => (
                <s-table-row key={product.productId}>
                  <s-table-cell>{product.title}</s-table-cell>
                  <s-table-cell>
                    {product.quantityPurchased.toLocaleString()}
                  </s-table-cell>
                  <s-table-cell>
                    {product.ordersCount.toLocaleString()}
                  </s-table-cell>
                  <s-table-cell>
                    {formatDate(product.lastPurchasedAt)}
                  </s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
      </s-section>

      <s-section heading="Recent purchases">
        {report.recentPurchases.length === 0 ? (
          <s-paragraph>
            No recent purchases found for the current filter.
          </s-paragraph>
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header>Order</s-table-header>
              <s-table-header>When</s-table-header>
              <s-table-header>Customer</s-table-header>
              <s-table-header>Ticket qty</s-table-header>
              <s-table-header>Matched revenue</s-table-header>
              <s-table-header>Order total</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {report.recentPurchases.map((purchase) => (
                <s-table-row
                  key={`${purchase.orderId ?? "unknown"}-${purchase.orderName}`}
                >
                  <s-table-cell>{purchase.orderName}</s-table-cell>
                  <s-table-cell>{formatDate(purchase.purchasedAt)}</s-table-cell>
                  <s-table-cell>{purchase.customerEmail ?? "-"}</s-table-cell>
                  <s-table-cell>
                    {purchase.matchedQuantity.toLocaleString()}
                  </s-table-cell>
                  <s-table-cell>
                    {formatMoney(
                      purchase.matchedRevenue.toFixed(2),
                      purchase.currency,
                    )}
                  </s-table-cell>
                  <s-table-cell>
                    {formatMoney(purchase.totalPrice, purchase.currency)}
                  </s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
