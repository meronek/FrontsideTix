-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "isOnline" BOOLEAN NOT NULL DEFAULT false,
    "scope" TEXT,
    "expires" TIMESTAMP(3),
    "accessToken" TEXT NOT NULL,
    "userId" BIGINT,
    "firstName" TEXT,
    "lastName" TEXT,
    "email" TEXT,
    "accountOwner" BOOLEAN NOT NULL DEFAULT false,
    "locale" TEXT,
    "collaborator" BOOLEAN DEFAULT false,
    "emailVerified" BOOLEAN DEFAULT false,
    "refreshToken" TEXT,
    "refreshTokenExpires" TIMESTAMP(3),

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Shop" (
    "id" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "emailLogoUrl" TEXT,
    "scopes" TEXT,
    "installedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Shop_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BillingTier" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "ticketCredits" INTEGER NOT NULL,
    "priceCents" INTEGER NOT NULL,
    "currencyCode" TEXT NOT NULL DEFAULT 'USD',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BillingTier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShopCreditBalance" (
    "shopId" TEXT NOT NULL,
    "freeCreditsRemaining" INTEGER NOT NULL DEFAULT 50,
    "purchasedCreditsBalance" INTEGER NOT NULL DEFAULT 0,
    "lifetimePurchased" INTEGER NOT NULL DEFAULT 0,
    "lifetimeConsumed" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShopCreditBalance_pkey" PRIMARY KEY ("shopId")
);

-- CreateTable
CREATE TABLE "ShopCreditLedger" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "billingTierId" TEXT,
    "type" TEXT NOT NULL,
    "creditsDelta" INTEGER NOT NULL,
    "amountCents" INTEGER,
    "currencyCode" TEXT,
    "externalChargeId" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShopCreditLedger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BillingPurchase" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "billingTierId" TEXT NOT NULL,
    "shopifyChargeId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "creditedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BillingPurchase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShopTicketProduct" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShopTicketProduct_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderTicket" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "orderName" TEXT,
    "customerEmail" TEXT,
    "ticketId" TEXT NOT NULL,
    "qrCodeDataUrl" TEXT NOT NULL,
    "checkedInAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrderTicket_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CheckInLog" (
    "id" TEXT NOT NULL,
    "orderTicketId" TEXT NOT NULL,
    "scannedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "scannerId" TEXT,
    "success" BOOLEAN NOT NULL DEFAULT true,
    "note" TEXT,

    CONSTRAINT "CheckInLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookDelivery" (
    "id" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "deliveryKey" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebhookDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PrivacyWebhookLog" (
    "id" TEXT NOT NULL,
    "shopId" TEXT,
    "shopDomain" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "payloadJson" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PrivacyWebhookLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Shop_shopDomain_key" ON "Shop"("shopDomain");

-- CreateIndex
CREATE UNIQUE INDEX "BillingTier_code_key" ON "BillingTier"("code");

-- CreateIndex
CREATE UNIQUE INDEX "ShopCreditLedger_externalChargeId_key" ON "ShopCreditLedger"("externalChargeId");

-- CreateIndex
CREATE INDEX "ShopCreditLedger_shopId_createdAt_idx" ON "ShopCreditLedger"("shopId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "BillingPurchase_shopifyChargeId_key" ON "BillingPurchase"("shopifyChargeId");

-- CreateIndex
CREATE INDEX "BillingPurchase_shopId_status_idx" ON "BillingPurchase"("shopId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ShopTicketProduct_shopId_productId_key" ON "ShopTicketProduct"("shopId", "productId");

-- CreateIndex
CREATE UNIQUE INDEX "OrderTicket_ticketId_key" ON "OrderTicket"("ticketId");

-- CreateIndex
CREATE UNIQUE INDEX "OrderTicket_shopId_orderId_key" ON "OrderTicket"("shopId", "orderId");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookDelivery_shopDomain_topic_deliveryKey_key" ON "WebhookDelivery"("shopDomain", "topic", "deliveryKey");

-- AddForeignKey
ALTER TABLE "ShopCreditBalance" ADD CONSTRAINT "ShopCreditBalance_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShopCreditLedger" ADD CONSTRAINT "ShopCreditLedger_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShopCreditLedger" ADD CONSTRAINT "ShopCreditLedger_billingTierId_fkey" FOREIGN KEY ("billingTierId") REFERENCES "BillingTier"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillingPurchase" ADD CONSTRAINT "BillingPurchase_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillingPurchase" ADD CONSTRAINT "BillingPurchase_billingTierId_fkey" FOREIGN KEY ("billingTierId") REFERENCES "BillingTier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShopTicketProduct" ADD CONSTRAINT "ShopTicketProduct_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderTicket" ADD CONSTRAINT "OrderTicket_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CheckInLog" ADD CONSTRAINT "CheckInLog_orderTicketId_fkey" FOREIGN KEY ("orderTicketId") REFERENCES "OrderTicket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PrivacyWebhookLog" ADD CONSTRAINT "PrivacyWebhookLog_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE SET NULL ON UPDATE CASCADE;

