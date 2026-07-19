import type { LinksFunction } from "react-router";

import BrandHeader from "../components/BrandHeader";
import brandStyles from "../styles/brand.css?url";

export const links: LinksFunction = () => [
  { rel: "stylesheet", href: brandStyles },
];

export default function PrivacyPage() {
  return (
    <div className="flex min-h-screen flex-col">
      <BrandHeader />
      <main className="mx-auto w-full max-w-3xl px-6 py-12 text-foreground">
        <h1 className="text-3xl font-semibold tracking-tight">Privacy Policy</h1>
        <p className="mt-2 text-sm text-brand-subtext">
          Last updated: June 18, 2026
        </p>

        <div className="mt-8 grid gap-8">
          <section className="brand-card rounded-2xl p-6">
            <h2 className="text-xl font-semibold">Overview</h2>
            <p className="mt-3 leading-relaxed text-brand-cream-muted">
              Frontside Tix is a Shopify app that generates QR code tickets from
              your orders and enables on-site event check-in. We collect and
              store only what is necessary to make the app work. We do not sell,
              share, or use your data for any purpose other than operating the
              features you see inside the app.
            </p>
          </section>

          <section className="brand-card rounded-2xl p-6">
            <h2 className="text-xl font-semibold">What We Collect</h2>
            <ul className="mt-3 grid gap-3 leading-relaxed text-brand-cream-muted">
              <li className="flex gap-3">
                <span className="mt-0.5 text-brand-subtext">•</span>
                <span>
                  <strong className="font-medium text-foreground">
                    Shopify store data
                  </strong>{" "}
                  — your shop domain and the access token Shopify issues when you
                  install the app, stored via Shopify&apos;s managed session
                  storage. This is required to call the Shopify API on your
                  behalf.
                </span>
              </li>
              <li className="flex gap-3">
                <span className="mt-0.5 text-brand-subtext">•</span>
                <span>
                  <strong className="font-medium text-foreground">
                    Order and customer data
                  </strong>{" "}
                  — order IDs, order names, and customer email addresses from
                  orders that contain ticket products. This data is used solely
                  to generate QR tickets and associate check-ins with the correct
                  order.
                </span>
              </li>
              <li className="flex gap-3">
                <span className="mt-0.5 text-brand-subtext">•</span>
                <span>
                  <strong className="font-medium text-foreground">
                    Check-in activity
                  </strong>{" "}
                  — timestamps and optional notes recorded when an attendee is
                  checked in at your event.
                </span>
              </li>
            </ul>
          </section>

          <section className="brand-card rounded-2xl p-6">
            <h2 className="text-xl font-semibold">How We Use Your Data</h2>
            <p className="mt-3 leading-relaxed text-brand-cream-muted">
              Every piece of data we store is used exclusively to deliver the
              functionality of Frontside Tix:
            </p>
            <ul className="mt-3 grid gap-2 leading-relaxed text-brand-cream-muted">
              <li className="flex gap-3">
                <span className="mt-0.5 text-brand-subtext">•</span>
                Generating and emailing QR code tickets to your customers
              </li>
              <li className="flex gap-3">
                <span className="mt-0.5 text-brand-subtext">•</span>
                Validating tickets and recording check-ins at your events
              </li>
              <li className="flex gap-3">
                <span className="mt-0.5 text-brand-subtext">•</span>
                Displaying reports and activity logs inside the app
              </li>
            </ul>
            <p className="mt-4 leading-relaxed text-brand-cream-muted">
              We do not use your data for advertising, analytics sold to third
              parties, machine learning, or any other purpose outside of running
              the app.
            </p>
          </section>

          <section className="brand-card rounded-2xl p-6">
            <h2 className="text-xl font-semibold">Data Sharing</h2>
            <p className="mt-3 leading-relaxed text-brand-cream-muted">
              We do not sell, rent, or share your data with any third parties.
              Outbound ticket emails are delivered through our email provider;
              only the recipient email address and the ticket details for that
              specific order are transmitted for this purpose. Logo images you
              upload are stored with our image hosting provider.
            </p>
          </section>

          <section className="brand-card rounded-2xl p-6">
            <h2 className="text-xl font-semibold">Data Deletion</h2>
            <p className="mt-3 leading-relaxed text-brand-cream-muted">
              When you uninstall Frontside Tix, your Shopify session is removed
              immediately. All remaining store data — order tickets, check-in
              logs, and credit balances — is permanently deleted when Shopify
              sends the mandatory shop-redaction request following uninstall.
            </p>
            <p className="mt-3 leading-relaxed text-brand-cream-muted">
              Customer data erasure requests submitted through Shopify&apos;s
              mandatory privacy webhooks are processed automatically. When
              Shopify notifies us of a customer data request or redaction, we
              remove or nullify the relevant customer email from all stored
              records for that customer.
            </p>
          </section>

          <section className="brand-card rounded-2xl p-6">
            <h2 className="text-xl font-semibold">Security</h2>
            <p className="mt-3 leading-relaxed text-brand-cream-muted">
              All data is transmitted over HTTPS. Shopify webhook payloads are
              verified using HMAC-SHA256 signatures. We apply reasonable
              technical and organizational measures to protect stored data
              against unauthorized access.
            </p>
          </section>

          <section className="brand-card rounded-2xl p-6">
            <h2 className="text-xl font-semibold">Contact</h2>
            <p className="mt-3 leading-relaxed text-brand-cream-muted">
              Questions about this policy or requests related to your data can be
              sent to{" "}
              <a
                href="mailto:support@frontsidetix.com"
                className="text-foreground underline hover:text-brand-teal"
              >
                support@frontsidetix.com
              </a>
              .
            </p>
          </section>
        </div>
      </main>
    </div>
  );
}
