-- CreateEnum
CREATE TYPE "NobleForwardingStatus" AS ENUM ('pending', 'registered', 'failed', 'stale');

-- CreateTable
CREATE TABLE "noble_forwarding_registration" (
    "id" TEXT NOT NULL,
    "noble_address" TEXT NOT NULL,
    "recipient" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "fallback" TEXT DEFAULT '',
    "status" "NobleForwardingStatus" NOT NULL DEFAULT 'pending',
    "balance_uusdc" BIGINT,
    "last_checked_at" TIMESTAMP(3),
    "registered_at" TIMESTAMP(3),
    "registration_tx_hash" TEXT,
    "error_message" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "noble_forwarding_registration_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "noble_forwarding_registration_noble_address_key" ON "noble_forwarding_registration"("noble_address");

-- CreateIndex
CREATE INDEX "noble_forwarding_registration_noble_address_idx" ON "noble_forwarding_registration"("noble_address");

-- CreateIndex
CREATE INDEX "noble_forwarding_registration_status_idx" ON "noble_forwarding_registration"("status");

-- CreateIndex
CREATE INDEX "noble_forwarding_registration_created_at_idx" ON "noble_forwarding_registration"("created_at");

