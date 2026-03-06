-- CreateTable
CREATE TABLE "announcements" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'info',
    "scope" TEXT NOT NULL DEFAULT 'global',
    "server_ids" TEXT[],
    "created_by_id" TEXT NOT NULL,
    "published_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "announcements_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "announcements_published_at_idx" ON "announcements"("published_at");

-- CreateIndex
CREATE INDEX "announcements_expires_at_idx" ON "announcements"("expires_at");

-- AddForeignKey
ALTER TABLE "announcements" ADD CONSTRAINT "announcements_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
