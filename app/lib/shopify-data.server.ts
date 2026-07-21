// GraphQL data helpers for the Admin API. The new template's `admin` context
// exposes ONLY `admin.graphql` (no REST client), so the old REST calls
// (products.json / orders.json) are reimplemented here as GraphQL.
//
// IDs: ticketing data stores numeric (REST/legacy) product & order ids. We query
// `legacyResourceId` so the values keep matching stored selections and webhook
// order payloads.
//
// Customer PII (order email/customer) is intentionally NOT requested here — it is
// "protected customer data" in the GraphQL Admin API and can fail without special
// approval. Customer email is sourced from the DB (OrderTicket.customerEmail,
// captured at webhook time) instead.

type AdminGraphqlClient = {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<Response>;
};

export type TicketProduct = { id: string; title: string; status: string };

const PRODUCTS_ALL_QUERY = `#graphql
  query TicketProductsAll($first: Int!) {
    products(first: $first, sortKey: TITLE) {
      nodes { legacyResourceId title status }
    }
  }`;

const PRODUCTS_BY_IDS_QUERY = `#graphql
  query TicketProductsByIds($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Product { legacyResourceId title status }
    }
  }`;

function throwIfAccessDenied(json: unknown) {
  const errors =
    typeof json === "object" && json !== null && "errors" in json
      ? (json as { errors?: Array<{ message?: string }> }).errors
      : undefined;

  const accessDenied = (errors ?? []).some((err) =>
    (err.message ?? "").toLowerCase().includes("access denied"),
  );

  if (accessDenied) {
    throw new Error(
      "Access denied for products field. This app must be granted the read_products scope. Run `shopify app deploy` and reinstall/re-auth the app in the store.",
    );
  }
}

export async function fetchTicketProducts(
  admin: AdminGraphqlClient,
  selectedIds: string[],
): Promise<TicketProduct[]> {
  if (selectedIds.length === 0) {
    const resp = await admin.graphql(PRODUCTS_ALL_QUERY, {
      variables: { first: 250 },
    });
    const json = (await resp.json()) as {
      errors?: Array<{ message?: string }>;
      data?: {
        products?: {
          nodes?: Array<{
            legacyResourceId?: string;
            title?: string;
            status?: string;
          }>;
        };
      };
    };
    throwIfAccessDenied(json);
    return (json.data?.products?.nodes ?? []).map((p) => ({
      id: String(p.legacyResourceId),
      title: p.title ?? "Untitled product",
      status: (p.status ?? "unknown").toLowerCase(),
    }));
  }

  const results: TicketProduct[] = [];
  for (let i = 0; i < selectedIds.length; i += 200) {
    const chunk = selectedIds
      .slice(i, i + 200)
      .map((id) => `gid://shopify/Product/${id}`);
    const resp = await admin.graphql(PRODUCTS_BY_IDS_QUERY, {
      variables: { ids: chunk },
    });
    const json = (await resp.json()) as {
      errors?: Array<{ message?: string }>;
      data?: {
        nodes?: Array<{
          legacyResourceId?: string;
          title?: string;
          status?: string;
        } | null>;
      };
    };
    throwIfAccessDenied(json);
    for (const node of json.data?.nodes ?? []) {
      if (node?.legacyResourceId) {
        results.push({
          id: String(node.legacyResourceId),
          title: node.title ?? "Untitled product",
          status: (node.status ?? "unknown").toLowerCase(),
        });
      }
    }
  }
  return results;
}

export type ReportOrderLineItem = {
  product_id: string | null;
  title: string;
  quantity: number;
  price: string;
};

export type ReportOrder = {
  id: string | null;
  name: string | null;
  created_at: string | null;
  total_price: string | null;
  currency: string | null;
  line_items: ReportOrderLineItem[];
};

const RECENT_ORDERS_QUERY = `#graphql
  query RecentOrders($first: Int!) {
    orders(first: $first, sortKey: CREATED_AT, reverse: true) {
      nodes {
        legacyResourceId
        name
        createdAt
        currentTotalPriceSet { shopMoney { amount currencyCode } }
        lineItems(first: 100) {
          nodes {
            title
            quantity
            product { legacyResourceId }
            originalUnitPriceSet { shopMoney { amount } }
          }
        }
      }
    }
  }`;

export async function fetchRecentOrders(
  admin: AdminGraphqlClient,
  first = 250,
): Promise<ReportOrder[]> {
  const resp = await admin.graphql(RECENT_ORDERS_QUERY, {
    variables: { first },
  });
  const json = (await resp.json()) as {
    data?: {
      orders?: {
        nodes?: Array<{
          legacyResourceId?: string;
          name?: string;
          createdAt?: string;
          currentTotalPriceSet?: {
            shopMoney?: { amount?: string; currencyCode?: string };
          };
          lineItems?: {
            nodes?: Array<{
              title?: string;
              quantity?: number;
              product?: { legacyResourceId?: string } | null;
              originalUnitPriceSet?: { shopMoney?: { amount?: string } };
            }>;
          };
        }>;
      };
    };
  };

  return (json.data?.orders?.nodes ?? []).map((o) => ({
    id: o.legacyResourceId ? String(o.legacyResourceId) : null,
    name: o.name ?? null,
    created_at: o.createdAt ?? null,
    total_price: o.currentTotalPriceSet?.shopMoney?.amount ?? null,
    currency: o.currentTotalPriceSet?.shopMoney?.currencyCode ?? null,
    line_items: (o.lineItems?.nodes ?? []).map((li) => ({
      product_id: li.product?.legacyResourceId
        ? String(li.product.legacyResourceId)
        : null,
      title: li.title ?? "Item",
      quantity: li.quantity ?? 0,
      price: li.originalUnitPriceSet?.shopMoney?.amount ?? "0.00",
    })),
  }));
}

export type OrderLineItemsInfo = {
  currency: string | null;
  lineItems: Array<{ title: string; quantity: number; price: string }>;
};

export type OrderCustomerDetailsInfo = {
  firstName: string | null;
  lastName: string | null;
  fullName: string | null;
  email: string | null;
  phone: string | null;
  shippingAddress: string | null;
  billingAddress: string | null;
};

const ORDER_LINE_ITEMS_QUERY = `#graphql
  query OrderLineItems($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Order {
        legacyResourceId
        currentTotalPriceSet { shopMoney { currencyCode } }
        lineItems(first: 100) {
          nodes {
            title
            quantity
            originalUnitPriceSet { shopMoney { amount } }
          }
        }
      }
    }
  }`;

const ORDER_CUSTOMER_DETAILS_QUERY = `#graphql
  query OrderCustomerDetails($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Order {
        legacyResourceId
        customer {
          firstName
          lastName
          displayName
          email
          phone
        }
        shippingAddress {
          address1
          address2
          city
          province
          zip
          country
        }
        billingAddress {
          address1
          address2
          city
          province
          zip
          country
        }
      }
    }
  }`;

function compactAddress(parts: Array<string | null | undefined>) {
  const filtered = parts
    .map((part) => (part ?? "").trim())
    .filter((part) => Boolean(part));
  return filtered.length ? filtered.join(", ") : null;
}

// Looks up line items + currency for a set of numeric order ids. Used to enrich
// the check-in search results and activity feed.
export async function fetchOrderLineItems(
  admin: AdminGraphqlClient,
  orderIds: string[],
): Promise<Map<string, OrderLineItemsInfo>> {
  const map = new Map<string, OrderLineItemsInfo>();
  const uniqueIds = [...new Set(orderIds.filter(Boolean))];
  if (uniqueIds.length === 0) return map;

  for (let i = 0; i < uniqueIds.length; i += 100) {
    const chunk = uniqueIds
      .slice(i, i + 100)
      .map((id) => `gid://shopify/Order/${id}`);
    const resp = await admin.graphql(ORDER_LINE_ITEMS_QUERY, {
      variables: { ids: chunk },
    });
    const json = (await resp.json()) as {
      data?: {
        nodes?: Array<{
          legacyResourceId?: string;
          currentTotalPriceSet?: { shopMoney?: { currencyCode?: string } };
          lineItems?: {
            nodes?: Array<{
              title?: string;
              quantity?: number;
              originalUnitPriceSet?: { shopMoney?: { amount?: string } };
            }>;
          };
        } | null>;
      };
    };
    for (const node of json.data?.nodes ?? []) {
      if (node?.legacyResourceId) {
        map.set(String(node.legacyResourceId), {
          currency: node.currentTotalPriceSet?.shopMoney?.currencyCode ?? null,
          lineItems: (node.lineItems?.nodes ?? []).map((li) => ({
            title: li.title ?? "Item",
            quantity: li.quantity ?? 0,
            price: li.originalUnitPriceSet?.shopMoney?.amount ?? "0.00",
          })),
        });
      }
    }
  }
  return map;
}

// Looks up customer and address context for a set of numeric order ids.
// If protected customer data is unavailable for the app/store, this returns
// an empty map instead of throwing so check-in search remains functional.
export async function fetchOrderCustomerDetails(
  admin: AdminGraphqlClient,
  orderIds: string[],
): Promise<Map<string, OrderCustomerDetailsInfo>> {
  const map = new Map<string, OrderCustomerDetailsInfo>();
  const uniqueIds = [...new Set(orderIds.filter(Boolean))];
  if (uniqueIds.length === 0) return map;

  for (let i = 0; i < uniqueIds.length; i += 100) {
    const chunk = uniqueIds
      .slice(i, i + 100)
      .map((id) => `gid://shopify/Order/${id}`);
    const resp = await admin.graphql(ORDER_CUSTOMER_DETAILS_QUERY, {
      variables: { ids: chunk },
    });
    const json = (await resp.json()) as {
      errors?: Array<{ message?: string }>;
      data?: {
        nodes?: Array<{
          legacyResourceId?: string;
          customer?: {
            firstName?: string | null;
            lastName?: string | null;
            displayName?: string | null;
            email?: string | null;
            phone?: string | null;
          } | null;
          shippingAddress?: {
            address1?: string | null;
            address2?: string | null;
            city?: string | null;
            province?: string | null;
            zip?: string | null;
            country?: string | null;
          } | null;
          billingAddress?: {
            address1?: string | null;
            address2?: string | null;
            city?: string | null;
            province?: string | null;
            zip?: string | null;
            country?: string | null;
          } | null;
        } | null>;
      };
    };

    const hasAccessDenied = (json.errors ?? []).some((err) => {
      const message = (err.message ?? "").toLowerCase();
      return (
        message.includes("access denied") ||
        message.includes("protected customer data")
      );
    });
    if (hasAccessDenied) {
      return new Map<string, OrderCustomerDetailsInfo>();
    }

    for (const node of json.data?.nodes ?? []) {
      if (!node?.legacyResourceId) continue;
      map.set(String(node.legacyResourceId), {
        firstName: node.customer?.firstName ?? null,
        lastName: node.customer?.lastName ?? null,
        fullName: node.customer?.displayName ?? null,
        email: node.customer?.email ?? null,
        phone: node.customer?.phone ?? null,
        shippingAddress: compactAddress([
          node.shippingAddress?.address1,
          node.shippingAddress?.address2,
          node.shippingAddress?.city,
          node.shippingAddress?.province,
          node.shippingAddress?.zip,
          node.shippingAddress?.country,
        ]),
        billingAddress: compactAddress([
          node.billingAddress?.address1,
          node.billingAddress?.address2,
          node.billingAddress?.city,
          node.billingAddress?.province,
          node.billingAddress?.zip,
          node.billingAddress?.country,
        ]),
      });
    }
  }

  return map;
}
