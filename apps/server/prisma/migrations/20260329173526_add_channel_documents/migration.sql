-- CreateTable
CREATE TABLE "channel_documents" (
    "channel_id" TEXT NOT NULL,
    "snapshot" BYTEA,
    "language" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "channel_documents_pkey" PRIMARY KEY ("channel_id")
);

-- AddForeignKey
ALTER TABLE "channel_documents" ADD CONSTRAINT "channel_documents_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;
