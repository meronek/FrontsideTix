import type { LinksFunction, LoaderFunctionArgs } from "react-router";
import { redirect, Form, useLoaderData } from "react-router";

import { login } from "../../shopify.server";
import BrandHeader from "../../components/BrandHeader";
import brandStyles from "../../styles/brand.css?url";

export const links: LinksFunction = () => [
  { rel: "stylesheet", href: brandStyles },
];

// AUTH: unchanged from the template. Redirect into the embedded app when a shop
// is present; otherwise show the Shopify login form.
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);

  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }

  return { showForm: Boolean(login) };
};

const FEATURES = [
  {
    title: "Automatic QR tickets",
    body: "Every order containing a ticket product automatically generates a unique QR code emailed directly to your customer — no manual work required.",
  },
  {
    title: "Fast on-site check-in",
    body: "Scan QR codes on any phone or tablet and get instant valid / invalid feedback. No dedicated hardware or app install needed.",
  },
  {
    title: "Reports & activity log",
    body: "See every check-in as it happens, review ticket orders, and export CSV reports — all from inside your Shopify admin.",
  },
  {
    title: "Simple credit pricing",
    body: "Start with 50 free check-ins. Buy credit packs any time; credits never expire and stack on your balance.",
  },
];

export default function Home() {
  const { showForm } = useLoaderData<typeof loader>();

  return (
    <div className="flex min-h-screen flex-col">
      <BrandHeader />
      <main className="mx-auto flex w-full max-w-4xl flex-col gap-8 px-6 py-12 text-foreground">
        <div className="space-y-3">
          <h1 className="text-4xl font-semibold tracking-tight">
            QR Code Event Check-In
            <br />
            for Shopify Ticket Orders
          </h1>
          <p className="max-w-2xl text-foreground/80">
            Sell event tickets through your Shopify store and check in attendees
            on-site with a phone or tablet — no extra hardware, no third-party
            ticketing platform.
          </p>
        </div>

        {showForm ? (
          <section className="brand-card grid max-w-md gap-4 rounded-2xl p-6">
            <h2 className="text-xl font-medium">Log in</h2>
            <Form className="grid gap-3" method="post" action="/auth/login">
              <label className="grid gap-1 text-sm text-brand-subtext">
                Shop domain
                <input
                  className="brand-input h-12 rounded-xl px-3"
                  type="text"
                  name="shop"
                  placeholder="my-shop-domain.myshopify.com"
                />
              </label>
              <button
                className="brand-button-primary h-12 rounded-xl px-4 font-medium"
                type="submit"
              >
                Log in
              </button>
            </Form>
          </section>
        ) : null}

        <div className="grid gap-4 sm:grid-cols-2">
          {FEATURES.map((feature) => (
            <div key={feature.title} className="brand-card rounded-2xl p-6">
              <h3 className="mb-2 font-semibold">{feature.title}</h3>
              <p className="text-sm text-brand-subtext">{feature.body}</p>
            </div>
          ))}
        </div>

        <section className="brand-card rounded-2xl p-6">
          <h2 className="mb-1 text-xl font-semibold">Ready to get started?</h2>
          <p className="mb-5 text-sm text-brand-subtext">
            Frontside Tix is installed directly from the Shopify App Store. Once
            installed, assign ticket products and start checking in attendees in
            minutes.
          </p>
          <div className="flex flex-wrap gap-3">
            <a
              href="https://apps.shopify.com/frontsidetix"
              target="_blank"
              rel="noreferrer"
              className="brand-button-primary rounded-xl px-5 py-2.5 text-sm font-medium"
            >
              Add to Shopify →
            </a>
            <a
              href="/pricing"
              className="brand-button-secondary rounded-xl px-5 py-2.5 text-sm"
            >
              View pricing
            </a>
          </div>
        </section>
      </main>
    </div>
  );
}
