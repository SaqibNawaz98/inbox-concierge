-- CreateTable
CREATE TABLE "MailTrainingExample" (
    "id" TEXT NOT NULL,
    "accountKey" TEXT NOT NULL,
    "gmailThreadId" TEXT NOT NULL,
    "bucket" TEXT NOT NULL,
    "subject" TEXT NOT NULL DEFAULT '',
    "preview" TEXT NOT NULL DEFAULT '',
    "sender" TEXT NOT NULL DEFAULT '',
    "embedding" JSONB NOT NULL,
    "embeddingModel" TEXT NOT NULL DEFAULT 'text-embedding-3-small',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MailTrainingExample_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MailTrainingExample_accountKey_idx" ON "MailTrainingExample"("accountKey");

-- CreateIndex
CREATE UNIQUE INDEX "MailTrainingExample_accountKey_gmailThreadId_key" ON "MailTrainingExample"("accountKey", "gmailThreadId");
