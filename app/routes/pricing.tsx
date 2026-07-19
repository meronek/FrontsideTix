import type { LinksFunction } from "react-router";

import BrandHeader from "../components/BrandHeader";
import brandStyles from "../styles/brand.css?url";

export const links: LinksFunction = () => [
  { rel: "stylesheet", href: brandStyles },
];

const APP_STORE_URL = "https://apps.shopify.com/frontsidetix";

const TIERS = [
  { name: "100 Tickets", credits: 100, priceCents: 1000, highlight: false },
  { name: "500 Tickets", credits: 500, priceCents: 4000, highlight: false },
  { name: "1,000 Tickets", credits: 1000, priceCents: 8500, highlight: false },
  { name: "5,000 Tickets", credits: 5000, priceCents: 30000, highlight: true },
] as const;

function formatDollars(cents: number) {
  return (cents / 100).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function perTicket(priceCents: number, credits: number) {
  const cents = priceCents / credits;
  if (cents < 1) {
    return `$${cents.toFixed(2)}`;
  }
  return formatDollars(Math.round(cents));
}

const FAQ = [
  {
    q: "When do credits get deducted?",
    a: "One credit is consumed each time a customer is successfully checked in by scanning their QR code. Duplicate scans and invalid tickets do not consume credits.",
  },
  {
    q: "Do credits expire?",
    a: "No. Purchased credits never expire. They stay in your balance until you use them, even across multiple events.",
  },
  {
    q: "Can I buy more than one pack?",
    a: "Yes. You can purchase packs at any time and the credits stack on top of your existing balance.",
  },
  {
    q: "What happens to my credits if I uninstall?",
    a: "Your balance and history are preserved if you reinstall. Data is permanently deleted only after Shopify's mandatory shop-redaction window following an uninstall.",
  },
];

export default function PricingPage() {
  return (
    <div className="flex min-h-screen flex-col">
      <BrandHeader />
      <main className="mx-auto w-full max-w-5xl px-6 py-12 text-foreground">
        <div className="text-center">
          <h1 className="text-4xl font-semibold tracking-tight">
            Simple, Transparent Pricing
          </h1>
          <p className="mx-auto mt-3 max-w-xl text-lg text-brand-subtext">
            Pay only for what you use. Credits never expire and are added
            directly to your balance when purchased.
          </p>
        </div>

        <div className="mt-8 rounded-2xl border border-brand-cream-muted/20 bg-brand-panel px-6 py-5 text-center">
          <p className="text-lg font-semibold">
            🎉 50 free check-ins included with every install
          </p>
          <p className="mt-1 text-sm text-brand-subtext">
            No credit card required to get started. Use your free credits, then
            buy a pack when you&apos;re ready.
          </p>
        </div>

        <div className="mt-8 grid gap-4 sm:grid-cols-2">
          {TIERS.map((tier) => (
            <article
              key={tier.name}
              className={`brand-card flex flex-col gap-4 rounded-2xl p-6 ${
                tier.highlight ? "relative ring-2 ring-brand-gold" : ""
              }`}
            >
              {tier.highlight ? (
                <div className="absolute -top-3 left-1/2 -translate-x-1/2">
                  <span className="rounded-full bg-brand-gold px-3 py-0.5 text-xs font-semibold text-foreground">
                    Best Value
                  </span>
                </div>
              ) : null}

              <div>
                <h2 className="text-xl font-semibold">{tier.name}</h2>
                <p className="mt-1 text-sm text-brand-subtext">
                  {tier.credits.toLocaleString()} ticket credits
                </p>
              </div>

              <div>
                <p className="text-4xl font-bold tracking-tight">
                  {formatDollars(tier.priceCents)}
                </p>
                <p className="mt-1 text-sm text-brand-subtext">
                  {perTicket(tier.priceCents, tier.credits)} per ticket
                </p>
              </div>

              <ul className="grid gap-2 text-sm text-brand-cream-muted">
                <li className="flex items-center gap-2">
                  <span className="text-brand-teal">✓</span>
                  {tier.credits.toLocaleString()} QR scan check-ins
                </li>
                <li className="flex items-center gap-2">
                  <span className="text-brand-teal">✓</span>
                  Credits added instantly after purchase
                </li>
                <li className="flex items-center gap-2">
                  <span className="text-brand-teal">✓</span>
                  Credits never expire
                </li>
                <li className="flex items-center gap-2">
                  <span className="text-brand-teal">✓</span>
                  Stacks with your existing balance
                </li>
              </ul>

              <a
                href={APP_STORE_URL}
                target="_blank"
                rel="noreferrer"
                className="brand-button-primary mt-auto rounded-xl px-4 py-2.5 text-center text-sm font-semibold"
              >
                Get Started
              </a>
            </article>
          ))}
        </div>

        <section className="brand-card mt-12 rounded-2xl p-6">
          <h2 className="mb-6 text-xl font-semibold">Common Questions</h2>
          <div className="grid gap-6 sm:grid-cols-2">
            {FAQ.map(({ q, a }) => (
              <div key={q}>
                <h3 className="font-semibold text-foreground">{q}</h3>
                <p className="mt-1 text-sm leading-relaxed text-brand-cream-muted">
                  {a}
                </p>
              </div>
            ))}
          </div>
        </section>
      </main>
    </div>
  );
}
