import crypto from "node:crypto";
import QRCode from "qrcode";

export function generateHardToGuessTicketId() {
  // 24+ chars of URL-safe randomness is hard to brute-force in public check-in flows.
  const entropy = crypto.randomBytes(18).toString("base64url");
  return `TKT_${entropy}`;
}

export function extractTicketIdFromQrData(rawValue: string) {
  const trimmed = rawValue.trim();
  if (!trimmed) return null;

  if (/^TKT_[A-Za-z0-9_-]+$/.test(trimmed)) {
    return trimmed;
  }

  try {
    const url = new URL(trimmed);
    const ticketIdFromQuery = url.searchParams.get("ticketId")?.trim();
    if (ticketIdFromQuery) {
      return ticketIdFromQuery;
    }

    const match = url.pathname.match(/\/ticket\/([^/]+)/);
    if (match?.[1]) {
      return decodeURIComponent(match[1]);
    }
  } catch {
    return null;
  }

  return null;
}

export function buildCheckInUrl(ticketId: string, shopDomain?: string) {
  const baseUrl = (
    process.env.SHOPIFY_APP_URL ?? "http://localhost:3000"
  ).replace(/\/$/, "");
  // QR scans should land on the public ticket page first. That page can then
  // offer a staff-only check-in link for logged-in admins.
  let url = `${baseUrl}/ticket/${encodeURIComponent(ticketId)}`;
  if (shopDomain) {
    url += `?shop=${encodeURIComponent(shopDomain)}`;
  }
  return url;
}

export async function createQrCodeDataUrl(
  ticketId: string,
  shopDomain?: string,
) {
  return QRCode.toDataURL(buildCheckInUrl(ticketId, shopDomain), {
    errorCorrectionLevel: "M",
    margin: 2,
    scale: 8,
  });
}
