import type { ChangeEvent } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import {
  useFetcher,
  useLoaderData,
  useRevalidator,
  useSearchParams,
} from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import db from "../db.server";
import { getOrCreateShop } from "../lib/shop.server";
import { consumeTicketCreditInTx } from "../lib/billing";
import { createMobileCheckInToken } from "../lib/mobile-checkin-token.server";
import { extractTicketIdFromQrData } from "../lib/ticket-id";
import {
  fetchOrderCustomerDetails,
  fetchOrderLineItems,
  type OrderCustomerDetailsInfo,
  type OrderLineItemsInfo,
} from "../lib/shopify-data.server";

type LineItem = { title: string; quantity: number; price: string };

const OUT_OF_CREDITS_MESSAGE =
  "You have run out of ticket credits, buy more now to continue checking your customers in.";
const SCANNER_REGION_ID = "ticket-qr-scanner-region";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = await getOrCreateShop(session.shop);
  const appBaseUrl = (process.env.SHOPIFY_APP_URL ?? "").replace(/\/$/, "");
  const mobileToken = createMobileCheckInToken({
    shopId: shop.id,
    shopDomain: session.shop,
  });

  const [recentCheckInRows, recentTicketRows] = await Promise.all([
    db.checkInLog.findMany({
      where: { success: true, orderTicket: { shopId: shop.id } },
      orderBy: { scannedAt: "desc" },
      take: 30,
      select: {
        id: true,
        scannedAt: true,
        scannerId: true,
        note: true,
        orderTicket: {
          select: {
            ticketId: true,
            orderId: true,
            orderName: true,
            customerEmail: true,
          },
        },
      },
    }),
    db.orderTicket.findMany({
      where: { shopId: shop.id },
      orderBy: { createdAt: "desc" },
      take: 30,
      select: {
        id: true,
        orderId: true,
        orderName: true,
        customerEmail: true,
        ticketId: true,
        checkedInAt: true,
        createdAt: true,
      },
    }),
  ]);

  const orderIds = [
    ...recentCheckInRows.map((r) => r.orderTicket.orderId),
    ...recentTicketRows.map((r) => r.orderId),
  ];
  const [lineItemsByOrderId, customerInfoByOrderId] = await Promise.all([
    fetchOrderLineItems(admin, orderIds).catch(
      () => new Map<string, OrderLineItemsInfo>(),
    ),
    fetchOrderCustomerDetails(admin, orderIds).catch(
      () => new Map<string, OrderCustomerDetailsInfo>(),
    ),
  ]);

  const recentCheckIns = recentCheckInRows.map((entry) => {
    const info = lineItemsByOrderId.get(entry.orderTicket.orderId);
    const customerInfo = customerInfoByOrderId.get(entry.orderTicket.orderId);
    return {
      id: entry.id,
      scannedAt: entry.scannedAt.toISOString(),
      scannerId: entry.scannerId,
      note: entry.note,
      orderTicket: {
        ticketId: entry.orderTicket.ticketId,
        orderName: entry.orderTicket.orderName,
        customerEmail: entry.orderTicket.customerEmail,
        customerFullName: customerInfo?.fullName ?? null,
        currency: info?.currency ?? null,
        lineItems: info?.lineItems ?? [],
      },
    };
  });

  const recentTicketOrders = recentTicketRows.map((entry) => {
    const info = lineItemsByOrderId.get(entry.orderId);
    const customerInfo = customerInfoByOrderId.get(entry.orderId);
    return {
      id: entry.id,
      createdAt: entry.createdAt.toISOString(),
      orderId: entry.orderId,
      orderName: entry.orderName,
      customerEmail: entry.customerEmail,
      customerFullName: customerInfo?.fullName ?? null,
      currency: info?.currency ?? null,
      lineItems: info?.lineItems ?? [],
      ticketId: entry.ticketId,
      checkedInAt: entry.checkedInAt?.toISOString() ?? null,
    };
  });

  return {
    recentCheckIns,
    recentTicketOrders,
    mobileScannerUrl: appBaseUrl
      ? `${appBaseUrl}/check-in/mobile?t=${encodeURIComponent(mobileToken)}`
      : `/check-in/mobile?t=${encodeURIComponent(mobileToken)}`,
  };
};

type SearchResult = {
  ticketId: string;
  orderName: string | null;
  customerEmail: string | null;
  customerFirstName: string | null;
  customerLastName: string | null;
  customerFullName: string | null;
  customerPhone: string | null;
  shippingAddress: string | null;
  billingAddress: string | null;
  currency: string | null;
  lineItems: LineItem[];
  checkedInAt: string | null;
  checkInNote: string | null;
  scannedAt: string | null;
};

type TicketView = {
  ticketId: string;
  orderName: string | null;
  customerEmail: string | null;
  customerFirstName?: string | null;
  customerLastName?: string | null;
  customerFullName?: string | null;
  customerPhone?: string | null;
  shippingAddress?: string | null;
  billingAddress?: string | null;
  checkedInAt?: string | null;
  createdAt?: string;
  lineItems: LineItem[];
  currency: string | null;
};

type CheckInActionData = {
  intent: string;
  results?: SearchResult[];
  valid?: boolean;
  reason?: "NOT_FOUND" | "ALREADY_CHECKED_IN" | "INSUFFICIENT_CREDITS";
  message?: string;
  checkedInAt?: string | null;
  checkInNote?: string | null;
  checkInScannerId?: string | null;
  ticket?: TicketView;
};

export const action = async ({
  request,
}: ActionFunctionArgs): Promise<CheckInActionData> => {
  const { admin, session } = await authenticate.admin(request);
  const shop = await getOrCreateShop(session.shop);
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");

  if (intent === "search") {
    const q = String(formData.get("q") ?? "").trim();
    if (!q) return { intent, results: [] };
    const tickets = await db.orderTicket.findMany({
      where: {
        shopId: shop.id,
        OR: [
          { customerEmail: { contains: q, mode: "insensitive" } },
          { orderName: { contains: q, mode: "insensitive" } },
        ],
      },
      select: {
        ticketId: true,
        orderId: true,
        orderName: true,
        customerEmail: true,
        checkedInAt: true,
        createdAt: true,
        checkInEvents: {
          where: { success: true },
          orderBy: { scannedAt: "desc" },
          take: 1,
          select: { note: true, scannedAt: true },
        },
      },
      orderBy: { createdAt: "desc" },
      take: 20,
    });
    const [info, customerInfo] = await Promise.all([
      fetchOrderLineItems(
        admin,
        tickets.map((t) => t.orderId),
      ).catch(() => new Map<string, OrderLineItemsInfo>()),
      fetchOrderCustomerDetails(
        admin,
        tickets.map((t) => t.orderId),
      ).catch(() => new Map<string, OrderCustomerDetailsInfo>()),
    ]);
    const results: SearchResult[] = tickets.map((t) => {
      const oi = info.get(t.orderId);
      const ci = customerInfo.get(t.orderId);
      return {
        ticketId: t.ticketId,
        orderName: t.orderName,
        customerEmail: t.customerEmail,
        customerFirstName: ci?.firstName ?? null,
        customerLastName: ci?.lastName ?? null,
        customerFullName: ci?.fullName ?? null,
        customerPhone: ci?.phone ?? null,
        shippingAddress: ci?.shippingAddress ?? null,
        billingAddress: ci?.billingAddress ?? null,
        currency: oi?.currency ?? null,
        lineItems: oi?.lineItems ?? [],
        checkedInAt: t.checkedInAt?.toISOString() ?? null,
        checkInNote: t.checkInEvents[0]?.note ?? null,
        scannedAt: t.checkInEvents[0]?.scannedAt?.toISOString() ?? null,
      };
    });
    return { intent, results };
  }

  if (intent === "lookup") {
    const ticketId = String(formData.get("ticketId") ?? "").trim();
    if (!ticketId) {
      return {
        intent,
        valid: false,
        reason: "NOT_FOUND",
        message: "Ticket ID is required",
      };
    }
    const ticket = await db.orderTicket.findUnique({
      where: { ticketId },
      select: {
        shopId: true,
        ticketId: true,
        orderId: true,
        orderName: true,
        customerEmail: true,
        checkedInAt: true,
        createdAt: true,
        checkInEvents: {
          where: { success: true },
          orderBy: { scannedAt: "desc" },
          take: 1,
          select: { note: true, scannerId: true },
        },
      },
    });
    if (!ticket || ticket.shopId !== shop.id) {
      return {
        intent,
        valid: false,
        reason: "NOT_FOUND",
        message:
          "Invalid ticket scan. This code does not match a valid ticket.",
      };
    }
    const info = (
      await fetchOrderLineItems(admin, [ticket.orderId]).catch(
        () => new Map<string, OrderLineItemsInfo>(),
      )
    ).get(ticket.orderId);
    const customerInfo = (
      await fetchOrderCustomerDetails(admin, [ticket.orderId]).catch(
        () => new Map<string, OrderCustomerDetailsInfo>(),
      )
    ).get(ticket.orderId);
    return {
      intent,
      valid: true,
      checkInNote: ticket.checkInEvents[0]?.note ?? null,
      checkInScannerId: ticket.checkInEvents[0]?.scannerId ?? null,
      ticket: {
        ticketId: ticket.ticketId,
        orderName: ticket.orderName,
        customerEmail: ticket.customerEmail,
        customerFirstName: customerInfo?.firstName ?? null,
        customerLastName: customerInfo?.lastName ?? null,
        customerFullName: customerInfo?.fullName ?? null,
        customerPhone: customerInfo?.phone ?? null,
        shippingAddress: customerInfo?.shippingAddress ?? null,
        billingAddress: customerInfo?.billingAddress ?? null,
        checkedInAt: ticket.checkedInAt?.toISOString() ?? null,
        createdAt: ticket.createdAt.toISOString(),
        lineItems: info?.lineItems ?? [],
        currency: info?.currency ?? null,
      },
    };
  }

  if (intent === "checkin") {
    const ticketId = String(formData.get("ticketId") ?? "").trim();
    const noteValue = String(formData.get("note") ?? "").trim() || undefined;
    const scannerId = "admin";

    const ticket = await db.orderTicket.findUnique({
      where: { ticketId },
      select: {
        id: true,
        shopId: true,
        ticketId: true,
        orderId: true,
        checkedInAt: true,
        orderName: true,
        customerEmail: true,
      },
    });
    if (!ticket || ticket.shopId !== shop.id) {
      return {
        intent,
        valid: false,
        reason: "NOT_FOUND",
        message:
          "Invalid ticket scan. This code does not match a valid ticket.",
      };
    }
    const info = (
      await fetchOrderLineItems(admin, [ticket.orderId]).catch(
        () => new Map<string, OrderLineItemsInfo>(),
      )
    ).get(ticket.orderId);
    const customerInfo = (
      await fetchOrderCustomerDetails(admin, [ticket.orderId]).catch(
        () => new Map<string, OrderCustomerDetailsInfo>(),
      )
    ).get(ticket.orderId);
    const ticketBase: TicketView = {
      ticketId: ticket.ticketId,
      orderName: ticket.orderName,
      customerEmail: ticket.customerEmail,
      customerFirstName: customerInfo?.firstName ?? null,
      customerLastName: customerInfo?.lastName ?? null,
      customerFullName: customerInfo?.fullName ?? null,
      customerPhone: customerInfo?.phone ?? null,
      shippingAddress: customerInfo?.shippingAddress ?? null,
      billingAddress: customerInfo?.billingAddress ?? null,
      lineItems: info?.lineItems ?? [],
      currency: info?.currency ?? null,
    };

    const now = new Date();
    const checkInResult = await db.$transaction(async (tx) => {
      const latest = await tx.orderTicket.findUnique({
        where: { id: ticket.id },
        select: { id: true, checkedInAt: true },
      });
      if (!latest) return { kind: "not-found" as const };

      if (latest.checkedInAt) {
        const latestSuccess = await tx.checkInLog.findFirst({
          where: { orderTicketId: ticket.id, success: true },
          orderBy: { scannedAt: "desc" },
          select: { id: true, note: true, scannerId: true },
        });
        const nextNote = noteValue?.trim() || null;
        if (nextNote !== null && latestSuccess?.id) {
          await tx.checkInLog.update({
            where: { id: latestSuccess.id },
            data: { note: nextNote },
          });
          return {
            kind: "already-note-updated" as const,
            checkedInAt: latest.checkedInAt,
            checkInNote: nextNote,
            checkInScannerId: latestSuccess.scannerId ?? null,
          };
        }
        await tx.checkInLog.create({
          data: {
            orderTicketId: ticket.id,
            scannerId,
            success: false,
            note: noteValue ?? "Duplicate scan",
          },
        });
        return {
          kind: "already" as const,
          checkedInAt: latest.checkedInAt,
          checkInNote: latestSuccess?.note ?? null,
          checkInScannerId: latestSuccess?.scannerId ?? null,
        };
      }

      const credit = await consumeTicketCreditInTx(
        tx,
        shop.id,
        "Customer checked in",
      );
      if (!credit.consumed) {
        await tx.checkInLog.create({
          data: {
            orderTicketId: ticket.id,
            scannerId,
            success: false,
            note: "Insufficient ticket credits",
          },
        });
        return { kind: "insufficient-credits" as const };
      }

      await tx.orderTicket.update({
        where: { id: ticket.id },
        data: { checkedInAt: now },
      });
      await tx.checkInLog.create({
        data: {
          orderTicketId: ticket.id,
          scannerId,
          success: true,
          note: noteValue,
        },
      });
      return {
        kind: "ok" as const,
        checkInNote: noteValue?.trim() || null,
        checkInScannerId: scannerId,
      };
    });

    if (checkInResult.kind === "not-found") {
      return {
        intent,
        valid: false,
        reason: "NOT_FOUND",
        message:
          "Invalid ticket scan. This code does not match a valid ticket.",
      };
    }
    if (checkInResult.kind === "already-note-updated") {
      return {
        intent,
        valid: true,
        reason: "ALREADY_CHECKED_IN",
        message: "Ticket already checked in. Note updated.",
        checkedInAt: checkInResult.checkedInAt.toISOString(),
        checkInNote: checkInResult.checkInNote,
        checkInScannerId: checkInResult.checkInScannerId,
        ticket: ticketBase,
      };
    }
    if (checkInResult.kind === "already") {
      return {
        intent,
        valid: false,
        reason: "ALREADY_CHECKED_IN",
        message:
          "Ticket already used. This attendee has already been checked in.",
        checkedInAt: checkInResult.checkedInAt.toISOString(),
        checkInNote: checkInResult.checkInNote,
        checkInScannerId: checkInResult.checkInScannerId,
        ticket: ticketBase,
      };
    }
    if (checkInResult.kind === "insufficient-credits") {
      return {
        intent,
        valid: false,
        reason: "INSUFFICIENT_CREDITS",
        message: OUT_OF_CREDITS_MESSAGE,
        ticket: ticketBase,
      };
    }
    return {
      intent,
      valid: true,
      checkedInAt: now.toISOString(),
      checkInNote: checkInResult.checkInNote,
      checkInScannerId: checkInResult.checkInScannerId,
      ticket: ticketBase,
    };
  }

  return { intent: "unknown" };
};

function formatPrice(price: string, currency: string | null) {
  const num = parseFloat(price);
  if (Number.isNaN(num)) return price;
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: currency ?? "USD",
    }).format(num);
  } catch {
    return `$${num.toFixed(2)}`;
  }
}

function formatLocalDate(value: string | null | undefined) {
  if (!value) return "-";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString();
}

function formatReportDate(value: string | null | undefined) {
  if (!value) return "-";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;

  const monthDay = parsed.toLocaleDateString(undefined, {
    month: "numeric",
    day: "numeric",
  });
  const time = parsed.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });

  return `${monthDay} ${time}`;
}

function formatCheckInStatusDate(value: string | null | undefined) {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;

  const datePart = parsed.toLocaleDateString(undefined, {
    month: "numeric",
    day: "numeric",
  });
  const timePart = parsed
    .toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    })
    .replace(/\s?([AP]M)$/i, (_, ampm) => ampm.toLowerCase());

  return `${datePart} at ${timePart}`;
}

function formatTicketHolderLabel(
  customerEmail: string | null,
  customerFullName: string | null,
  customerFirstName: string | null,
  customerLastName: string | null,
  orderName: string | null,
) {
  const normalizedName =
    customerFullName?.trim() ||
    `${customerFirstName ?? ""} ${customerLastName ?? ""}`.trim() ||
    null;

  if (normalizedName && customerEmail) {
    return `${normalizedName}, ${customerEmail}`;
  }
  if (normalizedName) {
    return normalizedName;
  }
  if (customerEmail) {
    return customerEmail;
  }

  return orderName ?? "Ticket Holder";
}

function renderLineItemsTable(
  lineItems: LineItem[],
  currency: string | null,
  formatPriceFn: (price: string, currency: string | null) => string,
) {
  if (lineItems.length === 0) return null;

  return (
    <div
      style={{
        width: "100%",
        overflowX: "auto",
        borderRadius: "1rem",
        border: "1px solid rgba(0, 0, 0, 0.1)",
        background: "#ffffff",
        boxShadow: "0 1px 2px rgba(0, 0, 0, 0.06)",
        marginTop: "0.5rem",
      }}
    >
      <table
        style={{
          width: "100%",
          tableLayout: "fixed",
          borderCollapse: "collapse",
          fontSize: "0.95rem",
          color: "#262626",
        }}
      >
        <colgroup>
          <col style={{ width: "5rem" }} />
          <col style={{ width: "auto" }} />
          <col style={{ width: "8rem" }} />
        </colgroup>
        <thead style={{ background: "#fff" }}>
          <tr style={{ borderBottom: "1px solid rgba(0, 0, 0, 0.1)" }}>
            <th
              style={{
                textAlign: "center",
                fontSize: "0.75rem",
                fontWeight: 600,
                textTransform: "uppercase",
                letterSpacing: "0.04em",
                color: "#737373",
                padding: "0.5rem",
              }}
            >
              Qty
            </th>
            <th
              style={{
                textAlign: "center",
                fontSize: "0.75rem",
                fontWeight: 600,
                textTransform: "uppercase",
                letterSpacing: "0.04em",
                color: "#737373",
                padding: "0.5rem",
              }}
            >
              Item
            </th>
            <th
              style={{
                textAlign: "center",
                fontSize: "0.75rem",
                fontWeight: 600,
                textTransform: "uppercase",
                letterSpacing: "0.04em",
                color: "#737373",
                padding: "0.5rem",
              }}
            >
              Price
            </th>
          </tr>
        </thead>
        <tbody>
          {lineItems.map((item, i, rows) => (
            <tr
              key={`${item.title}-${i}`}
              style={{
                borderBottom:
                  i === rows.length - 1
                    ? "none"
                    : "1px solid rgba(0, 0, 0, 0.1)",
              }}
            >
              <td
                style={{
                  padding: "0.75rem 1rem",
                  textAlign: "right",
                  fontVariantNumeric: "tabular-nums",
                }}
              >
                {item.quantity}
              </td>
              <td style={{ padding: "0.75rem 1rem", fontWeight: 500 }}>
                {item.title}
              </td>
              <td
                style={{
                  padding: "0.75rem 1rem",
                  textAlign: "right",
                  fontVariantNumeric: "tabular-nums",
                }}
              >
                {formatPriceFn(item.price, currency)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function CheckInPage() {
  const { recentCheckIns, recentTicketOrders, mobileScannerUrl } =
    useLoaderData<typeof loader>();
  const ticketFetcher = useFetcher<typeof action>();
  const searchFetcher = useFetcher<typeof action>();
  const revalidator = useRevalidator();
  const [searchParams] = useSearchParams();

  const [ticketId, setTicketId] = useState("");
  const [note, setNote] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [autoLookedUp, setAutoLookedUp] = useState<string | null>(null);
  const [scannerOpen, setScannerOpen] = useState(false);
  const [scannerError, setScannerError] = useState<string | null>(null);
  const [scannerStarting, setScannerStarting] = useState(false);
  const [photoScanLoading, setPhotoScanLoading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const scannerRef = useRef<import("html5-qrcode").Html5Qrcode | null>(null);

  const result =
    ticketFetcher.data &&
    (ticketFetcher.data.intent === "lookup" ||
      ticketFetcher.data.intent === "checkin")
      ? ticketFetcher.data
      : null;

  const lookupLoading = ticketFetcher.state !== "idle";
  const searchLoading = searchFetcher.state !== "idle";
  const searchResults = searchFetcher.data?.results ?? [];

  const ticketIdFromQuery = searchParams.get("ticketId")?.trim() ?? "";

  const lookup = useCallback(
    (id: string) => {
      const normalized = id.trim();
      if (!normalized) return;
      setTicketId(normalized);
      ticketFetcher.submit(
        { intent: "lookup", ticketId: normalized },
        { method: "POST" },
      );
    },
    [ticketFetcher],
  );

  const checkIn = useCallback(() => {
    const normalized = ticketId.trim();
    if (!normalized) return;
    ticketFetcher.submit(
      { intent: "checkin", ticketId: normalized, note: note.trim() },
      { method: "POST" },
    );
  }, [note, ticketFetcher, ticketId]);

  const closeScanner = useCallback(() => {
    const activeScanner = scannerRef.current;
    scannerRef.current = null;
    if (activeScanner) {
      void activeScanner
        .stop()
        .catch(() => undefined)
        .finally(() => {
          try {
            activeScanner.clear();
          } catch {
            // no-op
          }
        });
    }
    setScannerOpen(false);
    setScannerStarting(false);
  }, []);

  const handleDecodedTicket = useCallback(
    (decodedText: string) => {
      const decodedTicketId = extractTicketIdFromQrData(decodedText);
      if (!decodedTicketId) {
        setScannerError("QR code did not contain a valid ticket ID.");
        return;
      }

      setScannerError(null);
      closeScanner();
      lookup(decodedTicketId);
    },
    [closeScanner, lookup],
  );

  const handlePhotoScan = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const input = event.currentTarget;
      const file = input.files?.[0];
      input.value = "";
      if (!file) return;

      setPhotoScanLoading(true);
      setScannerError(null);
      try {
        const { Html5Qrcode } = await import("html5-qrcode");
        const tempRegionId = `${SCANNER_REGION_ID}-file`;
        const tempNode = document.createElement("div");
        tempNode.id = tempRegionId;
        tempNode.style.display = "none";
        document.body.appendChild(tempNode);

        const fileScanner = new Html5Qrcode(tempRegionId, {
          formatsToSupport: [],
          verbose: false,
        });

        try {
          const decodedText = await fileScanner.scanFile(file, false);
          handleDecodedTicket(decodedText);
        } finally {
          try {
            fileScanner.clear();
          } catch {
            // no-op
          }
          tempNode.remove();
        }
      } catch (error) {
        setScannerError(
          error instanceof Error
            ? error.message
            : "Unable to read a QR code from that image.",
        );
      } finally {
        setPhotoScanLoading(false);
      }
    },
    [handleDecodedTicket],
  );

  // Sync the note field whenever a ticket result loads.
  useEffect(() => {
    if (result?.ticket) {
      setNote(result.checkInNote ?? "");
    }
  }, [result?.ticket, result?.checkInNote]);

  // Auto-lookup when arriving with a ?ticketId= (e.g. deep link).
  useEffect(() => {
    if (ticketIdFromQuery && autoLookedUp !== ticketIdFromQuery) {
      setAutoLookedUp(ticketIdFromQuery);
      lookup(ticketIdFromQuery);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ticketIdFromQuery]);

  useEffect(() => {
    if (!scannerOpen) {
      return;
    }

    let cancelled = false;
    let scanner: import("html5-qrcode").Html5Qrcode | null = null;

    setScannerError(null);
    setScannerStarting(true);

    void (async () => {
      try {
        const { Html5Qrcode, Html5QrcodeSupportedFormats } =
          await import("html5-qrcode");
        const cameras = await Html5Qrcode.getCameras();
        if (!cameras.length) {
          throw new Error("No camera was found on this device.");
        }
        if (cancelled) return;

        scanner = new Html5Qrcode(SCANNER_REGION_ID, {
          formatsToSupport: [Html5QrcodeSupportedFormats.QR_CODE],
          verbose: false,
          useBarCodeDetectorIfSupported: true,
        });

        scannerRef.current = scanner;
        await scanner.start(
          { facingMode: "environment" },
          {
            fps: 10,
            qrbox: { width: 260, height: 260 },
            aspectRatio: 1,
          },
          (decodedText) => handleDecodedTicket(decodedText),
          () => undefined,
        );

        if (!cancelled) {
          setScannerStarting(false);
        }
      } catch (error) {
        if (cancelled) return;
        setScannerStarting(false);
        setScannerError(
          error instanceof Error
            ? error.message
            : "Unable to start the QR scanner.",
        );
      }
    })();

    return () => {
      cancelled = true;
      if (scanner) {
        void scanner
          .stop()
          .catch(() => undefined)
          .finally(() => {
            try {
              scanner?.clear();
            } catch {
              // no-op
            }
          });
        if (scannerRef.current === scanner) {
          scannerRef.current = null;
        }
      }
    };
  }, [handleDecodedTicket, scannerOpen]);

  const resolvedCheckedInAt =
    result?.checkedInAt ?? result?.ticket?.checkedInAt ?? null;
  const canCheckIn = Boolean(result?.valid && !resolvedCheckedInAt);
  const canUpdateNote = Boolean(result?.valid && resolvedCheckedInAt);

  const status = useMemo(() => {
    if (!result) {
      return {
        tone: "info" as const,
        text: "Search or enter a ticket ID to load details.",
      };
    }
    if (result.valid && resolvedCheckedInAt) {
      const checkedInLabel = formatCheckInStatusDate(resolvedCheckedInAt);
      return {
        tone: "critical" as const,
        text: checkedInLabel
          ? `Checked in on ${checkedInLabel}`
          : "Already checked in.",
      };
    }
    if (result.valid) {
      return {
        tone: "success" as const,
        text: "Ticket is valid. Ready to check in.",
      };
    }
    if (result.reason === "INSUFFICIENT_CREDITS") {
      return { tone: "warning" as const, text: "Out of ticket credits." };
    }
    return {
      tone: "critical" as const,
      text: result.message ?? "Invalid ticket.",
    };
  }, [result, resolvedCheckedInAt]);

  const ticketHolderLabel = result?.ticket
    ? formatTicketHolderLabel(
        result.ticket.customerEmail ?? null,
        result.ticket.customerFullName ?? null,
        result.ticket.customerFirstName ?? null,
        result.ticket.customerLastName ?? null,
        result.ticket.orderName ?? null,
      )
    : null;

  return (
    <s-page heading="Event check-in">
      <s-section heading="Staff mobile scanner">
        <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-5 text-center shadow-sm">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-emerald-700">
            Staff
          </p>
          <h2 className="mt-2 text-3xl font-semibold leading-tight text-emerald-950">
            QR Code Ticket Scanner
          </h2>

          <div className="mt-5 flex justify-center">
            <a
              href={mobileScannerUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex min-h-12 items-center justify-center rounded-full bg-emerald-700 px-8 py-3 text-base font-semibold text-white no-underline shadow-md transition hover:bg-emerald-800 hover:shadow-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-2"
            >
              Open QR Code Ticket Scanner
            </a>
          </div>
        </div>
      </s-section>

      <s-section>
        {result?.ticket ? (
          <s-stack direction="block" gap="small-300">
            <div className="rounded-2xl border border-black/10 bg-white shadow-sm">
              <h2 className="mt-2 text-3xl font-semibold leading-tight text-neutral-950">
                Check In {ticketHolderLabel}
              </h2>
              <s-banner tone={status.tone}>
                <s-paragraph>{status.text}</s-paragraph>
              </s-banner>
              <div className="mt-4 grid gap-2 text-sm text-neutral-700 sm:grid-cols-3">
                <p>
                  <strong>Order:</strong> {result.ticket.orderName ?? "Unknown"}
                  , {result.ticket.ticketId}
                  <br />
                  {result.ticket.customerEmail ?? " Email Unknown"}
                  <br />
                  {result.ticket.billingAddress}
                </p>
              </div>
            </div>

            {result.ticket.lineItems.length > 0 ? (
              <div
                style={{
                  width: "100%",
                  overflowX: "auto",
                  borderRadius: "1rem",
                  border: "1px solid rgba(0, 0, 0, 0.1)",
                  background: "#ffffff",
                  boxShadow: "0 1px 2px rgba(0, 0, 0, 0.06)",
                  marginBottom: "1rem",
                }}
              >
                <table
                  style={{
                    width: "100%",
                    tableLayout: "fixed",
                    borderCollapse: "collapse",
                    fontSize: "0.95rem",
                    color: "#262626",
                  }}
                >
                  <colgroup>
                    <col style={{ width: "5rem" }} />
                    <col style={{ width: "auto" }} />
                    <col style={{ width: "8rem" }} />
                  </colgroup>
                  <thead style={{ background: "#fff" }}>
                    <tr
                      style={{ borderBottom: "1px solid rgba(0, 0, 0, 0.1)" }}
                    >
                      <th
                        style={{
                          textAlign: "center",
                          fontSize: "0.75rem",
                          fontWeight: 600,
                          textTransform: "uppercase",
                          letterSpacing: "0.04em",
                          color: "#737373",
                        }}
                      >
                        Qty
                      </th>
                      <th
                        style={{
                          textAlign: "center",
                          fontSize: "0.75rem",
                          fontWeight: 600,
                          textTransform: "uppercase",
                          letterSpacing: "0.04em",
                          color: "#737373",
                        }}
                      >
                        Item
                      </th>
                      <th
                        style={{
                          textAlign: "center",
                          fontSize: "0.75rem",
                          fontWeight: 600,
                          textTransform: "uppercase",
                          letterSpacing: "0.04em",
                          color: "#737373",
                        }}
                      >
                        Price
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.ticket.lineItems.map((item, i, rows) => (
                      <tr
                        key={`${item.title}-${i}`}
                        style={{
                          borderBottom:
                            i === rows.length - 1
                              ? "none"
                              : "1px solid rgba(0, 0, 0, 0.1)",
                        }}
                      >
                        <td
                          style={{
                            padding: "0.75rem 1rem",
                            textAlign: "right",
                            fontVariantNumeric: "tabular-nums",
                          }}
                        >
                          {item.quantity}
                        </td>
                        <td
                          style={{ padding: "0.75rem 1rem", fontWeight: 500 }}
                        >
                          {item.title}
                        </td>
                        <td
                          style={{
                            padding: "0.75rem 1rem",
                            textAlign: "right",
                            fontVariantNumeric: "tabular-nums",
                          }}
                        >
                          {formatPrice(
                            item.price,
                            result.ticket?.currency ?? null,
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
          </s-stack>
        ) : null}

        {result?.valid ? (
          <s-stack direction="block" gap="base">
            <s-text-area
              label="Optional Check-In Note:"
              value={note}
              maxLength={250}
              onChange={(event: Event) =>
                setNote((event.currentTarget as HTMLTextAreaElement).value)
              }
            />
            {canCheckIn ? (
              <button
                type="button"
                onClick={checkIn}
                disabled={lookupLoading}
                style={{
                  backgroundColor: "#047857",
                  color: "#ffffff",
                  border: "none",
                  borderRadius: "9999px",
                  minHeight: "2.5rem",
                  padding: "0.5rem 1.25rem",
                  fontSize: "1.125rem",
                  fontWeight: 600,
                  lineHeight: 1,
                  cursor: lookupLoading ? "not-allowed" : "pointer",
                  opacity: lookupLoading ? 0.6 : 1,
                }}
              >
                {lookupLoading ? "Checking in..." : "Check In"}
              </button>
            ) : canUpdateNote ? (
              <button
                type="button"
                onClick={checkIn}
                disabled={lookupLoading}
                style={{
                  backgroundColor: "#047857",
                  color: "#ffffff",
                  border: "none",
                  borderRadius: "9999px",
                  minHeight: "2.5rem",
                  padding: "0.5rem 1.25rem",
                  fontSize: "1.125rem",
                  fontWeight: 600,
                  lineHeight: 1,
                  cursor: lookupLoading ? "not-allowed" : "pointer",
                  opacity: lookupLoading ? 0.6 : 1,
                }}
              >
                {lookupLoading ? "Updating..." : "Update Note"}
              </button>
            ) : null}
          </s-stack>
        ) : null}
      </s-section>

      <s-section heading="Search ticket orders">
        <searchFetcher.Form method="post">
          <input type="hidden" name="intent" value="search" />
          <s-stack direction="inline" gap="base" alignItems="end">
            <s-text-field
              name="q"
              label="Search by email or order #"
              value={searchQuery}
              onChange={(event: Event) =>
                setSearchQuery((event.currentTarget as HTMLInputElement).value)
              }
            />
            <s-button
              type="submit"
              variant="primary"
              {...(searchLoading ? { loading: true } : {})}
            >
              Search
            </s-button>
          </s-stack>
        </searchFetcher.Form>

        {searchResults.length > 0 ? (
          <s-stack direction="block" gap="small-300">
            {searchResults.map((item) => (
              <s-box
                key={item.ticketId}
                padding="small-200"
                borderWidth="base"
                borderRadius="base"
              >
                <s-stack direction="block" gap="small-500">
                  <s-text>
                    <strong>{item.orderName ?? "—"}</strong>
                    {item.customerEmail ? ` · ${item.customerEmail}` : ""}
                  </s-text>
                  {item.customerFullName ||
                  item.customerFirstName ||
                  item.customerLastName ? (
                    <s-text>
                      Name: {item.customerFullName ?? ""}
                      {item.customerFullName
                        ? ""
                        : `${item.customerFirstName ?? ""} ${item.customerLastName ?? ""}`.trim()}
                    </s-text>
                  ) : null}
                  {item.customerPhone ? (
                    <s-text>Phone: {item.customerPhone}</s-text>
                  ) : null}
                  {item.shippingAddress ? (
                    <s-text>Shipping: {item.shippingAddress}</s-text>
                  ) : null}
                  {item.billingAddress ? (
                    <s-text>Billing: {item.billingAddress}</s-text>
                  ) : null}
                  {item.lineItems.map((li, i) => (
                    <s-text key={i}>
                      {li.title} ×{li.quantity} ·{" "}
                      {formatPrice(li.price, item.currency)}
                    </s-text>
                  ))}
                  <s-text>
                    {item.ticketId}
                    {item.checkedInAt
                      ? ` · checked in ${formatLocalDate(item.checkedInAt)}`
                      : ""}
                  </s-text>
                  <s-button
                    variant="secondary"
                    onClick={() => lookup(item.ticketId)}
                  >
                    Load ticket
                  </s-button>
                </s-stack>
              </s-box>
            ))}
          </s-stack>
        ) : searchFetcher.data && searchResults.length === 0 ? (
          <s-paragraph>No results found.</s-paragraph>
        ) : null}
      </s-section>

      <s-section heading="Manual ticket entry">
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          capture="environment"
          style={{ display: "none" }}
          onChange={handlePhotoScan}
        />

        <s-stack direction="inline" gap="base" alignItems="end">
          <s-text-field
            name="ticketId"
            label="Ticket ID"
            value={ticketId}
            onChange={(event: Event) =>
              setTicketId((event.currentTarget as HTMLInputElement).value)
            }
          />
          <s-button
            variant="primary"
            onClick={() => lookup(ticketId)}
            {...(lookupLoading ? { loading: true } : {})}
          >
            Load ticket
          </s-button>
        </s-stack>

        {scannerError ? (
          <s-banner tone="critical">
            <s-paragraph>{scannerError}</s-paragraph>
          </s-banner>
        ) : null}

        {scannerOpen ? (
          <s-box padding="base" borderWidth="base" borderRadius="base">
            <s-stack direction="block" gap="base">
              <s-paragraph>
                Point your camera at a ticket QR code. The ticket will load
                automatically when detected.
              </s-paragraph>
              <div
                id={SCANNER_REGION_ID}
                style={{
                  width: "100%",
                  maxWidth: "420px",
                  minHeight: "320px",
                  borderRadius: "12px",
                  overflow: "hidden",
                  background: "#000",
                }}
              />
              {scannerStarting ? (
                <s-paragraph>Starting camera…</s-paragraph>
              ) : null}
            </s-stack>
          </s-box>
        ) : null}
      </s-section>

      <s-section heading="Recent activity">
        <s-button
          onClick={() => revalidator.revalidate()}
          {...(revalidator.state !== "idle" ? { loading: true } : {})}
        >
          Refresh
        </s-button>

        <s-grid
          gridTemplateColumns="repeat(auto-fit, minmax(320px, 1fr))"
          gap="base"
        >
          <s-box padding="base" borderWidth="base" borderRadius="base">
            <s-heading>Last 30 check-ins</s-heading>
            {recentCheckIns.length === 0 ? (
              <s-paragraph>No completed check-ins yet.</s-paragraph>
            ) : (
              <s-stack direction="block" gap="small-300">
                {recentCheckIns.map((entry) => (
                  <s-box key={entry.id}>
                    <s-text>
                      <strong>
                        {entry.orderTicket.customerFullName ??
                          entry.orderTicket.orderName ??
                          "—"}
                      </strong>
                      {entry.orderTicket.customerEmail
                        ? ` · ${entry.orderTicket.customerEmail}`
                        : ""}
                    </s-text>
                    {renderLineItemsTable(
                      entry.orderTicket.lineItems,
                      entry.orderTicket.currency,
                      formatPrice,
                    )}
                    <s-text>
                      {entry.orderTicket.ticketId} ·{" "}
                      {formatReportDate(entry.scannedAt)}
                    </s-text>
                  </s-box>
                ))}
              </s-stack>
            )}
          </s-box>

          <s-box padding="base" borderWidth="base" borderRadius="base">
            <s-heading>Last 30 ticket orders</s-heading>
            {recentTicketOrders.length === 0 ? (
              <s-paragraph>No ticket orders yet.</s-paragraph>
            ) : (
              <s-stack direction="block" gap="small-300">
                {recentTicketOrders.map((entry) => (
                  <s-box key={entry.id}>
                    <s-text>
                      <strong>
                        {entry.customerFullName ??
                          entry.orderName ??
                          `Order ${entry.orderId}`}
                      </strong>
                      {entry.customerEmail ? ` · ${entry.customerEmail}` : ""}
                    </s-text>
                    {renderLineItemsTable(
                      entry.lineItems,
                      entry.currency,
                      formatPrice,
                    )}
                    <s-text>
                      {entry.ticketId !== "-" ? `${entry.ticketId} · ` : ""}
                      {formatReportDate(entry.createdAt)}
                      {entry.checkedInAt ? " · checked in" : ""}
                    </s-text>
                  </s-box>
                ))}
              </s-stack>
            )}
          </s-box>
        </s-grid>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
