-- CreateTable
CREATE TABLE "channel_reads" (
    "user_id" TEXT NOT NULL,
    "channel_id" TEXT NOT NULL,
    "last_read_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "channel_reads_pkey" PRIMARY KEY ("user_id","channel_id")
);

-- AddForeignKey
ALTER TABLE "channel_reads" ADD CONSTRAINT "channel_reads_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_reads" ADD CONSTRAINT "channel_reads_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;
