-- CreateTable
CREATE TABLE "gif_uploads" (
    "id" TEXT NOT NULL,
    "s3_key" TEXT NOT NULL,
    "file_name" TEXT NOT NULL,
    "file_size" INTEGER NOT NULL,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "uploader_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "gif_uploads_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "gif_uploads_s3_key_key" ON "gif_uploads"("s3_key");

-- CreateIndex
CREATE INDEX "gif_uploads_uploader_id_idx" ON "gif_uploads"("uploader_id");

-- CreateIndex
CREATE INDEX "gif_uploads_tags_idx" ON "gif_uploads"("tags");

-- AddForeignKey
ALTER TABLE "gif_uploads" ADD CONSTRAINT "gif_uploads_uploader_id_fkey" FOREIGN KEY ("uploader_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
