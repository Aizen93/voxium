-- CreateTable
CREATE TABLE "custom_emojis" (
    "id" TEXT NOT NULL,
    "server_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "s3_key" TEXT NOT NULL,
    "animated" BOOLEAN NOT NULL DEFAULT false,
    "creator_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "custom_emojis_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sticker_packs" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "server_id" TEXT,
    "user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sticker_packs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stickers" (
    "id" TEXT NOT NULL,
    "pack_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "s3_key" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stickers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "custom_emojis_server_id_idx" ON "custom_emojis"("server_id");

-- CreateIndex
CREATE UNIQUE INDEX "custom_emojis_server_id_name_key" ON "custom_emojis"("server_id", "name");

-- CreateIndex
CREATE INDEX "sticker_packs_server_id_idx" ON "sticker_packs"("server_id");

-- CreateIndex
CREATE INDEX "sticker_packs_user_id_idx" ON "sticker_packs"("user_id");

-- CreateIndex
CREATE INDEX "stickers_pack_id_idx" ON "stickers"("pack_id");

-- CreateIndex
CREATE UNIQUE INDEX "stickers_pack_id_name_key" ON "stickers"("pack_id", "name");

-- CheckConstraint: exactly one of server_id or user_id must be set
ALTER TABLE "sticker_packs" ADD CONSTRAINT "sticker_packs_owner_check"
  CHECK (("server_id" IS NOT NULL AND "user_id" IS NULL) OR ("server_id" IS NULL AND "user_id" IS NOT NULL));

-- AddForeignKey
ALTER TABLE "custom_emojis" ADD CONSTRAINT "custom_emojis_server_id_fkey" FOREIGN KEY ("server_id") REFERENCES "servers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "custom_emojis" ADD CONSTRAINT "custom_emojis_creator_id_fkey" FOREIGN KEY ("creator_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sticker_packs" ADD CONSTRAINT "sticker_packs_server_id_fkey" FOREIGN KEY ("server_id") REFERENCES "servers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sticker_packs" ADD CONSTRAINT "sticker_packs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stickers" ADD CONSTRAINT "stickers_pack_id_fkey" FOREIGN KEY ("pack_id") REFERENCES "sticker_packs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
