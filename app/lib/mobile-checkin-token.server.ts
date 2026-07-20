import crypto from "node:crypto";

export type MobileCheckInTokenPayload = {
  shopId: string;
  shopDomain: string;
  exp: number;
};

const TOKEN_VERSION = "v1";

function base64UrlEncode(value: string) {
  return Buffer.from(value, "utf8").toString("base64url");
}

function base64UrlDecode(value: string) {
  return Buffer.from(value, "base64url").toString("utf8");
}

function getSigningSecret() {
  const secret =
    process.env.MOBILE_CHECKIN_SECRET ?? process.env.SHOPIFY_API_SECRET;
  if (!secret) {
    throw new Error("Missing MOBILE_CHECKIN_SECRET or SHOPIFY_API_SECRET");
  }
  return secret;
}

function signToken(payloadPart: string) {
  return crypto
    .createHmac("sha256", getSigningSecret())
    .update(payloadPart)
    .digest("base64url");
}

export function createMobileCheckInToken(
  params: { shopId: string; shopDomain: string },
  ttlSeconds = 60 * 60 * 8,
) {
  const payload: MobileCheckInTokenPayload = {
    shopId: params.shopId,
    shopDomain: params.shopDomain,
    exp: Math.floor(Date.now() / 1000) + ttlSeconds,
  };

  const payloadPart = `${TOKEN_VERSION}.${base64UrlEncode(JSON.stringify(payload))}`;
  const signature = signToken(payloadPart);
  return `${payloadPart}.${signature}`;
}

export function verifyMobileCheckInToken(token: string | null | undefined):
  | {
      valid: true;
      payload: MobileCheckInTokenPayload;
    }
  | {
      valid: false;
      reason: "MISSING" | "MALFORMED" | "BAD_SIGNATURE" | "EXPIRED";
    } {
  if (!token) {
    return { valid: false, reason: "MISSING" };
  }

  const parts = token.split(".");
  if (parts.length !== 3) {
    return { valid: false, reason: "MALFORMED" };
  }

  const [version, encodedPayload, signature] = parts;
  if (version !== TOKEN_VERSION || !encodedPayload || !signature) {
    return { valid: false, reason: "MALFORMED" };
  }

  const payloadPart = `${version}.${encodedPayload}`;
  const expectedSignature = signToken(payloadPart);
  if (signature.length !== expectedSignature.length) {
    return { valid: false, reason: "BAD_SIGNATURE" };
  }
  const matches = crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(expectedSignature),
  );
  if (!matches) {
    return { valid: false, reason: "BAD_SIGNATURE" };
  }

  try {
    const parsed = JSON.parse(
      base64UrlDecode(encodedPayload),
    ) as MobileCheckInTokenPayload;
    if (
      typeof parsed.shopId !== "string" ||
      typeof parsed.shopDomain !== "string" ||
      typeof parsed.exp !== "number"
    ) {
      return { valid: false, reason: "MALFORMED" };
    }

    if (parsed.exp <= Math.floor(Date.now() / 1000)) {
      return { valid: false, reason: "EXPIRED" };
    }

    return { valid: true, payload: parsed };
  } catch {
    return { valid: false, reason: "MALFORMED" };
  }
}
