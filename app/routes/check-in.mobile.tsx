import type { ChangeEvent } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ActionFunctionArgs,
  LinksFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useFetcher, useLoaderData } from "react-router";

import db from "../db.server";
import { consumeTicketCreditInTx } from "../lib/billing";
import {
  verifyMobileCheckInToken,
  type MobileCheckInTokenPayload,
} from "../lib/mobile-checkin-token.server";
import { extractTicketIdFromQrData } from "../lib/tickets";
import BrandHeader from "../components/BrandHeader";
import brandStyles from "../styles/brand.css?url";

const OUT_OF_CREDITS_MESSAGE =
  "You have run out of ticket credits, buy more now to continue checking your customers in.";
const SCANNER_REGION_ID = "mobile-ticket-qr-scanner-region";

type MobileLoaderData =
  | {
      authorized: false;
      token: string;
      message: string;
    }
  | {
      authorized: true;
      token: string;
      shopDomain: string;
      expiresAt: string;
    };

type TicketView = {
  ticketId: string;
  orderName: string | null;
  customerEmail: string | null;
  checkedInAt: string | null;
};

type MobileActionData = {
  intent: string;
  valid?: boolean;
  reason?:
    | "NOT_FOUND"
    | "ALREADY_CHECKED_IN"
    | "INSUFFICIENT_CREDITS"
    | "UNAUTHORIZED";
  message?: string;
  checkedInAt?: string | null;
  checkInNote?: string | null;
  ticket?: TicketView;
};

function tokenErrorMessage(
  reason: "MISSING" | "MALFORMED" | "BAD_SIGNATURE" | "EXPIRED",
) {
  if (reason === "EXPIRED") {
    return "This mobile check-in link has expired. Open a new scanner link from the app.";
  }
  return "This mobile check-in link is invalid. Open a new scanner link from the app.";
}

function getAuthorizedPayload(token: string | null | undefined):
  | {
      ok: true;
      payload: MobileCheckInTokenPayload;
    }
  | {
      ok: false;
      message: string;
    } {
  try {
    const verification = verifyMobileCheckInToken(token);
    if (!verification.valid) {
      return { ok: false, message: tokenErrorMessage(verification.reason) };
    }
    return { ok: true, payload: verification.payload };
  } catch {
    return {
      ok: false,
      message:
        "Mobile check-in is not configured correctly. Contact the app administrator.",
    };
  }
}

export const links: LinksFunction = () => [
  { rel: "stylesheet", href: brandStyles },
];

export const loader = async ({
  request,
}: LoaderFunctionArgs): Promise<MobileLoaderData> => {
  const url = new URL(request.url);
  const token = url.searchParams.get("t")?.trim() ?? "";
  const authorized = getAuthorizedPayload(token);

  if (!authorized.ok) {
    return {
      authorized: false,
      token,
      message: authorized.message,
    };
  }

  return {
    authorized: true,
    token,
    shopDomain: authorized.payload.shopDomain,
    expiresAt: new Date(authorized.payload.exp * 1000).toISOString(),
  };
};

export const action = async ({
  request,
}: ActionFunctionArgs): Promise<MobileActionData> => {
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");
  const token = String(formData.get("t") ?? "").trim();

  const authorized = getAuthorizedPayload(token);
  if (!authorized.ok) {
    return {
      intent,
      valid: false,
      reason: "UNAUTHORIZED",
      message: authorized.message,
    };
  }

  const { shopId, shopDomain } = authorized.payload;

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
        orderName: true,
        customerEmail: true,
        checkedInAt: true,
      },
    });

    if (!ticket || ticket.shopId !== shopId) {
      return {
        intent,
        valid: false,
        reason: "NOT_FOUND",
        message:
          "Invalid ticket scan. This code does not match a valid ticket.",
      };
    }

    return {
      intent,
      valid: true,
      ticket: {
        ticketId: ticket.ticketId,
        orderName: ticket.orderName,
        customerEmail: ticket.customerEmail,
        checkedInAt: ticket.checkedInAt?.toISOString() ?? null,
      },
    };
  }

  if (intent === "checkin") {
    const ticketId = String(formData.get("ticketId") ?? "").trim();
    const noteValue = String(formData.get("note") ?? "").trim() || undefined;

    const ticket = await db.orderTicket.findUnique({
      where: { ticketId },
      select: {
        id: true,
        shopId: true,
        ticketId: true,
        orderName: true,
        customerEmail: true,
        checkedInAt: true,
      },
    });

    if (!ticket || ticket.shopId !== shopId) {
      return {
        intent,
        valid: false,
        reason: "NOT_FOUND",
        message:
          "Invalid ticket scan. This code does not match a valid ticket.",
      };
    }

    const scannerId = `mobile:${shopDomain}`;
    const now = new Date();

    const checkInResult = await db.$transaction(async (tx) => {
      const latest = await tx.orderTicket.findUnique({
        where: { id: ticket.id },
        select: { checkedInAt: true },
      });

      if (!latest) return { kind: "not-found" as const };

      if (latest.checkedInAt) {
        const latestSuccess = await tx.checkInLog.findFirst({
          where: { orderTicketId: ticket.id, success: true },
          orderBy: { scannedAt: "desc" },
          select: { id: true, note: true },
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
            note: nextNote,
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
          note: latestSuccess?.note ?? null,
        };
      }

      const credit = await consumeTicketCreditInTx(
        tx,
        shopId,
        "Customer checked in (mobile)",
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

      return { kind: "ok" as const, note: noteValue?.trim() || null };
    });

    const ticketBase: TicketView = {
      ticketId: ticket.ticketId,
      orderName: ticket.orderName,
      customerEmail: ticket.customerEmail,
      checkedInAt: ticket.checkedInAt?.toISOString() ?? null,
    };

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
        checkInNote: checkInResult.note,
        ticket: {
          ...ticketBase,
          checkedInAt: checkInResult.checkedInAt.toISOString(),
        },
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
        checkInNote: checkInResult.note,
        ticket: {
          ...ticketBase,
          checkedInAt: checkInResult.checkedInAt.toISOString(),
        },
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
      checkInNote: checkInResult.note,
      ticket: {
        ...ticketBase,
        checkedInAt: now.toISOString(),
      },
    };
  }

  return { intent: "unknown" };
};

function formatLocalDate(value: string | null | undefined) {
  if (!value) return "-";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString();
}

export default function MobileCheckInPage() {
  const loaderData = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const [ticketId, setTicketId] = useState("");
  const [note, setNote] = useState("");
  const [scannerOpen, setScannerOpen] = useState(false);
  const [scannerError, setScannerError] = useState<string | null>(null);
  const [scannerStarting, setScannerStarting] = useState(false);
  const [photoScanLoading, setPhotoScanLoading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const scannerRef = useRef<import("html5-qrcode").Html5Qrcode | null>(null);

  const actionResult =
    fetcher.data &&
    (fetcher.data.intent === "lookup" || fetcher.data.intent === "checkin")
      ? fetcher.data
      : null;

  const resolvedCheckedInAt =
    actionResult?.checkedInAt ?? actionResult?.ticket?.checkedInAt ?? null;
  const canCheckIn = Boolean(actionResult?.valid && !resolvedCheckedInAt);
  const canUpdateNote = Boolean(actionResult?.valid && resolvedCheckedInAt);
  const isBusy = fetcher.state !== "idle";

  const lookup = useCallback(
    (nextTicketId: string) => {
      if (!loaderData.authorized) return;
      const normalized = nextTicketId.trim();
      if (!normalized) return;
      setTicketId(normalized);
      fetcher.submit(
        { intent: "lookup", ticketId: normalized, t: loaderData.token },
        { method: "POST" },
      );
    },
    [fetcher, loaderData],
  );

  const checkIn = useCallback(() => {
    if (!loaderData.authorized) return;
    const normalized = ticketId.trim();
    if (!normalized) return;
    fetcher.submit(
      {
        intent: "checkin",
        ticketId: normalized,
        note: note.trim(),
        t: loaderData.token,
      },
      { method: "POST" },
    );
  }, [fetcher, loaderData, note, ticketId]);

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

  useEffect(() => {
    if (!scannerOpen || !loaderData.authorized) {
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
  }, [handleDecodedTicket, loaderData, scannerOpen]);

  const status = useMemo(() => {
    if (!actionResult) {
      return "Scan or enter a ticket ID to load details.";
    }
    return (
      actionResult.message ??
      (actionResult.valid
        ? resolvedCheckedInAt
          ? "Ticket already checked in."
          : "Ticket is valid. Ready to check in."
        : "Invalid ticket.")
    );
  }, [actionResult, resolvedCheckedInAt]);

  useEffect(() => {
    if (actionResult?.ticket) {
      setNote(actionResult.checkInNote ?? "");
    }
  }, [actionResult?.checkInNote, actionResult?.ticket]);

  if (!loaderData.authorized) {
    return (
      <div className="flex min-h-screen flex-col">
        <BrandHeader />
        <main className="mx-auto flex w-full max-w-xl flex-1 flex-col gap-6 px-6 py-12 text-foreground">
          <div className="rounded-3xl border border-red-200 bg-red-50 p-6 shadow-sm">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-red-700">
              Access denied
            </p>
            <h1 className="mt-2 text-3xl font-semibold leading-tight text-red-900">
              Mobile check-in link is not valid
            </h1>
            <p className="mt-4 text-sm text-red-800">{loaderData.message}</p>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col bg-[radial-gradient(circle_at_top_left,_#d1fae5,_transparent_45%),linear-gradient(180deg,_#f8fafc_0%,_#ecfdf5_100%)]">
      <BrandHeader />
      <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6 px-5 py-8 text-foreground sm:px-6">
        <section className="rounded-3xl border border-emerald-200 bg-white/90 p-6 shadow-sm backdrop-blur">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-emerald-700">
            Secure mobile session
          </p>
          <h1 className="mt-2 text-3xl font-semibold leading-tight text-neutral-950 sm:text-4xl">
            Ticket Scanner
          </h1>
          <p className="mt-3 text-sm text-neutral-700">
            Store: <strong>{loaderData.shopDomain}</strong>
          </p>
          <p className="mt-1 text-xs text-neutral-500">
            Link expires: {formatLocalDate(loaderData.expiresAt)}
          </p>
          <p className="mt-4 text-sm text-neutral-700">{status}</p>
        </section>

        <section className="rounded-3xl border border-black/10 bg-white p-5 shadow-sm">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            capture="environment"
            style={{ display: "none" }}
            onChange={handlePhotoScan}
          />

          <div className="flex flex-wrap gap-3">
            <button
              type="button"
              onClick={() => setScannerOpen((open) => !open)}
              className="rounded-full bg-emerald-700 px-5 py-2 text-sm font-semibold text-white transition hover:bg-emerald-800"
            >
              {scannerOpen ? "Close scanner" : "Scan QR code"}
            </button>
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="rounded-full border border-neutral-300 bg-white px-5 py-2 text-sm font-semibold text-neutral-800 transition hover:bg-neutral-100"
            >
              {photoScanLoading ? "Reading photo..." : "Use photo"}
            </button>
          </div>

          <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-end">
            <label className="flex-1">
              <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-neutral-500">
                Ticket ID
              </span>
              <input
                type="text"
                value={ticketId}
                onChange={(event) => setTicketId(event.currentTarget.value)}
                className="w-full rounded-xl border border-neutral-300 px-4 py-3 text-base text-neutral-900 outline-none ring-emerald-400 transition focus:ring"
                placeholder="TKT_..."
              />
            </label>
            <button
              type="button"
              onClick={() => lookup(ticketId)}
              disabled={isBusy}
              className="rounded-full border border-neutral-300 bg-white px-5 py-2 text-sm font-semibold text-neutral-800 transition enabled:hover:bg-neutral-100 disabled:opacity-50"
            >
              Load ticket
            </button>
          </div>

          {scannerError ? (
            <p className="mt-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
              {scannerError}
            </p>
          ) : null}

          {scannerOpen ? (
            <div className="mt-4 rounded-2xl border border-black/10 bg-neutral-950 p-3">
              <div
                id={SCANNER_REGION_ID}
                style={{
                  width: "100%",
                  maxWidth: "420px",
                  minHeight: "300px",
                  borderRadius: "12px",
                  overflow: "hidden",
                  background: "#000",
                }}
              />
              {scannerStarting ? (
                <p className="mt-2 text-sm text-neutral-200">
                  Starting camera...
                </p>
              ) : null}
            </div>
          ) : null}
        </section>

        {actionResult?.ticket ? (
          <section className="rounded-3xl border border-black/10 bg-white p-5 shadow-sm">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-neutral-500">
              Ticket
            </p>
            <h2 className="mt-2 text-2xl font-semibold text-neutral-950">
              {actionResult.ticket.orderName ?? "Unknown order"}
            </h2>
            <div className="mt-3 space-y-1 text-sm text-neutral-700">
              <p>
                <strong>Ticket:</strong> {actionResult.ticket.ticketId}
              </p>
              <p>
                <strong>Email:</strong>{" "}
                {actionResult.ticket.customerEmail ?? "Unknown"}
              </p>
              <p>
                <strong>Status:</strong>{" "}
                {resolvedCheckedInAt
                  ? `Checked in at ${formatLocalDate(resolvedCheckedInAt)}`
                  : "Ready to check in"}
              </p>
            </div>

            <div className="mt-4">
              <label>
                <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-neutral-500">
                  Optional note
                </span>
                <textarea
                  value={note}
                  onChange={(event) => setNote(event.currentTarget.value)}
                  className="h-24 w-full rounded-xl border border-neutral-300 px-4 py-3 text-sm text-neutral-900 outline-none ring-emerald-400 transition focus:ring"
                  maxLength={250}
                />
              </label>
            </div>

            <div className="mt-4">
              {canCheckIn ? (
                <button
                  type="button"
                  onClick={checkIn}
                  disabled={isBusy}
                  className="rounded-full bg-emerald-700 px-5 py-2 text-sm font-semibold text-white transition enabled:hover:bg-emerald-800 disabled:opacity-50"
                >
                  Check in attendee
                </button>
              ) : canUpdateNote ? (
                <button
                  type="button"
                  onClick={checkIn}
                  disabled={isBusy}
                  className="rounded-full border border-neutral-300 bg-white px-5 py-2 text-sm font-semibold text-neutral-800 transition enabled:hover:bg-neutral-100 disabled:opacity-50"
                >
                  Update note
                </button>
              ) : null}
            </div>
          </section>
        ) : null}
      </main>
    </div>
  );
}
