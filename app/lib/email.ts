import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { ServerClient } from "postmark";
import {
  type OrderLineItem,
  renderOrderTicketEmailTemplate,
} from "./email-template";

type SendOrderTicketEmailInput = {
  to: string;
  orderName?: string;
  orderId: string;
  lineItems: OrderLineItem[];
  qrCodeDataUrl: string;
  ticketId: string;
  logoUrl?: string | null;
};

let cachedClient: ServerClient | null = null;
let cachedLogoBase64: string | null = null;
let logoChecked = false;

function getClient() {
  if (cachedClient) return cachedClient;
  const token = process.env.POSTMARK_SERVER_CLIENT?.trim();
  if (!token) return null;
  cachedClient = new ServerClient(token);
  return cachedClient;
}

function parseQrDataUrl(dataUrl: string) {
  const match = dataUrl.match(/^data:(.+?);base64,(.+)$/);
  if (!match) return null;
  return { mimeType: match[1], base64: match[2] };
}

async function getLogoBase64() {
  if (cachedLogoBase64) return cachedLogoBase64;
  if (logoChecked) return null;
  logoChecked = true;

  try {
    const logoPath = path.join(process.cwd(), "public", "logowide1.png");
    await access(logoPath);
    const buf = await readFile(logoPath);
    cachedLogoBase64 = buf.toString("base64");
    return cachedLogoBase64;
  } catch {
    return null;
  }
}

export async function sendOrderTicketEmail(input: SendOrderTicketEmailInput) {
  const client = getClient();
  const from = process.env.EMAIL_FROM?.trim();

  if (!client || !from) {
    return { sent: false, reason: "email-not-configured" as const };
  }

  const qr = parseQrDataUrl(input.qrCodeDataUrl);
  if (!qr) {
    return { sent: false, reason: "invalid-qr-data-url" as const };
  }

  const logoBase64 = await getLogoBase64();

  const orderLabel = input.orderName ?? `Order ${input.orderId}`;
  const template = renderOrderTicketEmailTemplate({
    orderLabel,
    lineItems: input.lineItems,
    ticketId: input.ticketId,
    logoCid: input.logoUrl ? undefined : logoBase64 ? "brandlogo" : undefined,
    logoUrl: input.logoUrl ?? undefined,
  });

  const attachments: Array<{
    Name: string;
    Content: string;
    ContentType: string;
    ContentID: string;
  }> = [
    {
      Name: "ticket-qr.png",
      Content: qr.base64,
      ContentType: qr.mimeType,
      ContentID: "cid:ticketqr",
    },
  ];

  if (!input.logoUrl && logoBase64) {
    attachments.push({
      Name: "logowide1.png",
      Content: logoBase64,
      ContentType: "image/png",
      ContentID: "cid:brandlogo",
    });
  }

  await client.sendEmail({
    From: from,
    To: input.to,
    Subject: template.subject,
    HtmlBody: template.html,
    TextBody: template.text,
    MessageStream: "outbound",
    Attachments: attachments,
  });

  return { sent: true as const };
}
