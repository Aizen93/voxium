-- CreateTable
CREATE TABLE "global_config" (
    "id" TEXT NOT NULL DEFAULT 'global',
    "max_channels_per_server" INTEGER NOT NULL DEFAULT 100,
    "max_voice_users_per_channel" INTEGER NOT NULL DEFAULT 99,
    "max_categories_per_server" INTEGER NOT NULL DEFAULT 50,
    "max_members_per_server" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "global_config_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "server_limits" (
    "server_id" TEXT NOT NULL,
    "max_channels_per_server" INTEGER,
    "max_voice_users_per_channel" INTEGER,
    "max_categories_per_server" INTEGER,
    "max_members_per_server" INTEGER,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "server_limits_pkey" PRIMARY KEY ("server_id")
);

-- AddForeignKey
ALTER TABLE "server_limits" ADD CONSTRAINT "server_limits_server_id_fkey" FOREIGN KEY ("server_id") REFERENCES "servers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
