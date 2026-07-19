declare module "*.css";

// Vite `?url` stylesheet imports (used to scope brand.css to public routes).
declare module "*.css?url" {
  const href: string;
  export default href;
}

// App Bridge custom elements (provided at runtime by app-bridge.js / AppProvider),
// not part of @shopify/polaris-types. Declared here so JSX typechecks.
declare namespace JSX {
  interface IntrinsicElements {
    "s-app-nav": { children?: unknown };
  }
}
