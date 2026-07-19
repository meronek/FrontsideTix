import type { LinksFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";

import db from "../db.server";
import BrandHeader from "../components/BrandHeader";
import brandStyles from "../styles/brand.css?url";

export const links: LinksFunction = () => [
  { rel: "stylesheet", href: brandStyles },
];

// Public ticket view — the QR code target. No Shopify auth: the ticketId itself
// is a hard-to-guess capability token.
export const loader = async ({ params }: LoaderFunctionArgs) => {
  const ticketId = params.ticketId;
  if (!ticketId) {
    throw new Response("Not found", { status: 404 });
  }

  const ticket = await db.orderTicket.findUnique({
    where: { ticketId },
    select: {
      ticketId: true,
      qrCodeDataUrl: true,
      orderName: true,
      customerEmail: true,
      checkedInAt: true,
    },
  });

  if (!ticket) {
    throw new Response("Ticket not found", { status: 404 });
  }

  return {
    ticket: {
      ticketId: ticket.ticketId,
      qrCodeDataUrl: ticket.qrCodeDataUrl,
      orderName: ticket.orderName,
      customerEmail: ticket.customerEmail,
      checkedIn: Boolean(ticket.checkedInAt),
    },
  };
};

export default function TicketPage() {
  const { ticket } = useLoaderData<typeof loader>();

  return (
    <div className="flex min-h-screen flex-col">
      <BrandHeader />
      <main className="mx-auto flex w-full max-w-xl flex-col items-center gap-6 px-6 py-12 text-foreground">
        <h1 className="text-3xl font-semibold">Your Event Ticket</h1>
        <p className="text-center text-brand-subtext">
          Show this QR code at the event entrance for verification and check-in.
        </p>

        {/* Data URL is generated server-side and stored per order. */}
        <img
          src={ticket.qrCodeDataUrl}
          alt="Event ticket QR code"
          width={288}
          height={288}
        />

        <div className="brand-card w-full rounded-xl p-4 text-sm">
          <p>
            <strong>Ticket ID:</strong> {ticket.ticketId}
          </p>
          <p>
            <strong>Order:</strong> {ticket.orderName ?? "Unknown"}
          </p>
          <p>
            <strong>Email:</strong> {ticket.customerEmail ?? "Unknown"}
          </p>
          <p>
            <strong>Status:</strong>{" "}
            {ticket.checkedIn ? "Checked in" : "Not checked in"}
          </p>
        </div>
      </main>
    </div>
  );
}
