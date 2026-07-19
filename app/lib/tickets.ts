import crypto from "node:crypto";
import QRCode from "qrcode";

export function generateHardToGuessTicketId() {
  // 24+ chars of URL-safe randomness is hard to brute-force in public check-in flows.
  const entropy = crypto.randomBytes(18).toString("base64url");
  return `TKT_${entropy}`;
}

export function buildCheckInUrl(ticketId: string, shopDomain?: string) {
  const baseUrl = (
    process.env.SHOPIFY_APP_URL ?? "http://localhost:3000"
  ).replace(/\/$/, "");
  // QR scans should land on the staff check-in workflow. This route is admin-
  // protected via authenticate.admin(), so unauthenticated users are forced
  // through Shopify auth before they can check in a ticket.
  let url = `${baseUrl}/app/check-in?ticketId=${encodeURIComponent(ticketId)}`;
  if (shopDomain) {
    url += `&shop=${encodeURIComponent(shopDomain)}`;
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
