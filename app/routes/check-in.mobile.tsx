import type { LinksFunction } from "react-router";

import BrandHeader from "../components/BrandHeader";
import brandStyles from "../styles/brand.css?url";

export const links: LinksFunction = () => [
  { rel: "stylesheet", href: brandStyles },
];

export default function MobileCheckInSkeletonPage() {
  return (
    <div className="flex min-h-screen flex-col">
      <BrandHeader />
      <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6 px-6 py-12 text-foreground">
        <div className="rounded-3xl border border-black/10 bg-white p-6 shadow-sm">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-neutral-500">
            Test Route
          </p>
          <h1 className="mt-2 text-4xl font-semibold leading-tight text-neutral-950">
            Mobile QR Scanner
          </h1>
          <p className="mt-4 text-sm text-neutral-700">
            This is a temporary standalone route for testing how Shopify opens
            an external scanner page on mobile devices.
          </p>
          <p className="mt-3 text-sm text-neutral-700">
            If you are seeing this page outside the embedded admin app, the
            browser handoff works and we can build a separate mobile scanner
            flow here.
          </p>
        </div>
      </main>
    </div>
  );
}
