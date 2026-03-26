-- CreateTable
CREATE TABLE "community_themes" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "colors" JSONB NOT NULL,
    "patterns" JSONB,
    "version" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "install_count" INTEGER NOT NULL DEFAULT 0,
    "author_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "community_themes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "community_themes_status_install_count_idx" ON "community_themes"("status", "install_count");

-- CreateIndex
CREATE INDEX "community_themes_status_created_at_idx" ON "community_themes"("status", "created_at");

-- CreateIndex
CREATE INDEX "community_themes_author_id_idx" ON "community_themes"("author_id");

-- CreateIndex
CREATE UNIQUE INDEX "community_themes_author_id_name_key" ON "community_themes"("author_id", "name");

-- AddForeignKey
ALTER TABLE "community_themes" ADD CONSTRAINT "community_themes_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
