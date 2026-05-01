-- CreateTable
CREATE TABLE "SavedCustomBuckets" (
    "id" TEXT NOT NULL,
    "accountKey" TEXT NOT NULL,
    "buckets" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SavedCustomBuckets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SavedCustomBuckets_accountKey_key" ON "SavedCustomBuckets"("accountKey");
