import db from "../db.server";

// Resolves (and lazily creates) the per-shop ticketing anchor row from the
// authenticated Shopify session's shop domain. Replaces the old token-based
// Shop lookup — the Shopify access token now lives in Session (template auth).
export async function getOrCreateShop(shopDomain: string) {
  return db.shop.upsert({
    where: { shopDomain },
    update: {},
    create: { shopDomain },
  });
}

export async function getShopByDomain(shopDomain: string) {
  return db.shop.findUnique({ where: { shopDomain } });
}
