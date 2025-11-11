-- CreateEnum
CREATE TYPE "FlowType" AS ENUM ('deposit', 'payment');

-- CreateTable
CREATE TABLE "TrackedTransaction" (
    "id" TEXT NOT NULL,
    "txHash" TEXT NOT NULL,
    "chain" TEXT NOT NULL,
    "chainType" TEXT NOT NULL,
    "flowType" "FlowType",
    "initialChain" TEXT,
    "status" TEXT NOT NULL,
    "chainProgress" JSONB,
    "metadata" JSONB,
    "lastCheckedAt" TIMESTAMP(3),
    "nextCheckAfter" TIMESTAMP(3),
    "errorState" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "address_id" TEXT,

    CONSTRAINT "TrackedTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TransactionStatusLog" (
    "id" TEXT NOT NULL,
    "transaction_id" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "chain" TEXT,
    "source" TEXT DEFAULT 'poller',
    "detail" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TransactionStatusLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrackedAddress" (
    "id" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "chain" TEXT NOT NULL,
    "labels" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "metadata" JSONB,
    "last_synced_at" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TrackedAddress_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PollCheckpoint" (
    "id" TEXT NOT NULL,
    "address_id" TEXT,
    "chain" TEXT NOT NULL,
    "cursor" TEXT,
    "height" BIGINT,
    "metadata" JSONB,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PollCheckpoint_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TrackedTransaction_txHash_key" ON "TrackedTransaction"("txHash");

-- CreateIndex
CREATE UNIQUE INDEX "TrackedAddress_address_key" ON "TrackedAddress"("address");

-- AddForeignKey
ALTER TABLE "TrackedTransaction" ADD CONSTRAINT "TrackedTransaction_address_id_fkey" FOREIGN KEY ("address_id") REFERENCES "TrackedAddress"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TransactionStatusLog" ADD CONSTRAINT "TransactionStatusLog_transaction_id_fkey" FOREIGN KEY ("transaction_id") REFERENCES "TrackedTransaction"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PollCheckpoint" ADD CONSTRAINT "PollCheckpoint_address_id_fkey" FOREIGN KEY ("address_id") REFERENCES "TrackedAddress"("id") ON DELETE CASCADE ON UPDATE CASCADE;
