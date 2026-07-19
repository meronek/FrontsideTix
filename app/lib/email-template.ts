type OrderLineItem = {
  name?: string;
  title?: string;
  variant_title?: string | null;
  quantity?: number;
};

type RenderOrderTicketEmailTemplateInput = {
  orderLabel: string;
  lineItems: OrderLineItem[];
  ticketId: string;
  logoCid?: string;
  logoUrl?: string;
};

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatLineItems(lineItems: OrderLineItem[]) {
  if (!lineItems.length) {
    return {
      text: "- Item details unavailable",
      html: "<li>Item details unavailable</li>",
    };
  }

  const text = lineItems
    .map((item) => {
      const label = item.name ?? item.title ?? "Item";
      const qty = item.quantity ?? 1;
      const variant = item.variant_title ? ` (${item.variant_title})` : "";
      return `- ${label}${variant} x${qty}`;
    })
    .join("\n");

  const html = lineItems
    .map((item) => {
      const label = escapeHtml(item.name ?? item.title ?? "Item");
      const qty = item.quantity ?? 1;
      const variant = item.variant_title
        ? ` <span style="color:#B7B06A">(${escapeHtml(item.variant_title)})</span>`
        : "";
      return `<li style="margin-bottom:8px;">${label}${variant} x${qty}</li>`;
    })
    .join("");

  return { text, html };
}

export function renderOrderTicketEmailTemplate(
  input: RenderOrderTicketEmailTemplateInput,
) {
  const lineItemSummary = formatLineItems(input.lineItems);
  const intro =
    "Thanks for your order, here are your items you ordered. Show this QR code at the front gate check-in to get in.";

  const resolvedLogoSrc = input.logoUrl
    ? escapeHtml(input.logoUrl)
    : input.logoCid
      ? `cid:${escapeHtml(input.logoCid)}`
      : null;

  const logoHtml = resolvedLogoSrc
    ? `<img src="${resolvedLogoSrc}" alt="Frontside Tix" width="350" style="display:block;width:100%;max-width:350px;height:auto;margin:0 auto 20px;" />`
    : "";

  return {
    subject: `Your ticket for ${input.orderLabel}`,
    text: `${intro}\n\n${input.orderLabel}\n\n${lineItemSummary.text}\n\nTicket ID: ${input.ticketId}`,
    html: `
      <div style="margin:0;padding:24px;background:#E6E1C5;">
        <div style="max-width:660px;margin:0 auto;background:#111213;border:1px solid rgba(230,225,197,0.32);border-radius:18px;overflow:hidden;font-family:Verdana,Arial,sans-serif;color:#EDE7C9;">
          <div style="padding:22px 24px;background:#3F8F83;color:#EDE7C9;">
            <p style="margin:0;font-size:12px;letter-spacing:.14em;text-transform:uppercase;opacity:.9;">Frontside Tix</p>
            <h1 style="margin:8px 0 0;font-size:24px;line-height:1.2;">You're on the List!</h1>
          </div>
          <div style="padding:24px;">
            ${logoHtml}
            <p style="margin:0 0 14px;font-size:16px;line-height:1.55;color:#EDE7C9;">${intro}</p>
            <p style="margin:0 0 10px;font-size:16px;"><strong>${escapeHtml(input.orderLabel)}</strong></p>
            <ul style="margin:0 0 18px;padding-left:22px;font-size:15px;line-height:1.45;color:#E6E1C5;">${lineItemSummary.html}</ul>
            <div style="margin:0 0 16px;padding:12px 14px;background:#171A1D;border:1px solid rgba(230,225,197,0.24);border-radius:12px;">
              <p style="margin:0;font-size:14px;color:#EDE7C9;"><strong>Ticket ID:</strong> ${escapeHtml(input.ticketId)}</p>
            </div>
            <p style="margin:0 0 10px;font-size:14px;color:#B7B06A;">Present this QR code at check-in:</p>
            <div style="display:inline-block;padding:12px;border-radius:14px;border:1px solid rgba(230,225,197,0.28);background:#EDE7C9;">
              <img src="cid:ticketqr" alt="Ticket QR code" width="280" height="280" style="display:block;" />
            </div>
          </div>
        </div>
      </div>
    `,
  };
}

export type { OrderLineItem };
