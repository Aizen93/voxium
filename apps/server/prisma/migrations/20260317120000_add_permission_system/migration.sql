-- CreateTable
CREATE TABLE "roles" (
    "id" TEXT NOT NULL,
    "server_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT,
    "position" INTEGER NOT NULL DEFAULT 0,
    "permissions" TEXT NOT NULL DEFAULT '0',
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "member_roles" (
    "user_id" TEXT NOT NULL,
    "server_id" TEXT NOT NULL,
    "role_id" TEXT NOT NULL,

    CONSTRAINT "member_roles_pkey" PRIMARY KEY ("user_id","server_id","role_id")
);

-- CreateTable
CREATE TABLE "channel_permission_overrides" (
    "id" TEXT NOT NULL,
    "channel_id" TEXT NOT NULL,
    "role_id" TEXT NOT NULL,
    "allow" TEXT NOT NULL DEFAULT '0',
    "deny" TEXT NOT NULL DEFAULT '0',

    CONSTRAINT "channel_permission_overrides_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "roles_server_id_position_idx" ON "roles"("server_id", "position");

-- CreateIndex
CREATE UNIQUE INDEX "roles_server_id_name_key" ON "roles"("server_id", "name");

-- CreateIndex
CREATE INDEX "member_roles_role_id_idx" ON "member_roles"("role_id");

-- CreateIndex
CREATE INDEX "channel_permission_overrides_channel_id_idx" ON "channel_permission_overrides"("channel_id");

-- CreateIndex
CREATE UNIQUE INDEX "channel_permission_overrides_channel_id_role_id_key" ON "channel_permission_overrides"("channel_id", "role_id");

-- AddForeignKey
ALTER TABLE "roles" ADD CONSTRAINT "roles_server_id_fkey" FOREIGN KEY ("server_id") REFERENCES "servers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "member_roles" ADD CONSTRAINT "member_roles_user_id_server_id_fkey" FOREIGN KEY ("user_id", "server_id") REFERENCES "server_members"("user_id", "server_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "member_roles" ADD CONSTRAINT "member_roles_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_permission_overrides" ADD CONSTRAINT "channel_permission_overrides_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_permission_overrides" ADD CONSTRAINT "channel_permission_overrides_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Seed: Create @everyone role for each existing server with default permissions
-- DEFAULT_EVERYONE_PERMISSIONS = VIEW_CHANNEL(1) | SEND_MESSAGES(512) | ATTACH_FILES(2048) | ADD_REACTIONS(4096) | CONNECT(16384) | SPEAK(32768) | CREATE_INVITES(32) | CHANGE_NICKNAME(256) = 56097
INSERT INTO "roles" ("id", "server_id", "name", "color", "position", "permissions", "is_default", "created_at", "updated_at")
SELECT
    gen_random_uuid()::text,
    s."id",
    'everyone',
    NULL,
    0,
    '56097',
    true,
    NOW(),
    NOW()
FROM "servers" s
WHERE NOT EXISTS (
    SELECT 1 FROM "roles" r WHERE r."server_id" = s."id" AND r."is_default" = true
);

-- Seed: Create Admin role for existing servers that have admin members
-- DEFAULT_ADMIN_PERMISSIONS = DEFAULT_EVERYONE + MANAGE_CHANNELS(2) + MANAGE_CATEGORIES(4) + MANAGE_ROLES(16) + KICK_MEMBERS(64) + MANAGE_MESSAGES(1024) + MANAGE_NICKNAMES(128) + MENTION_EVERYONE(8192) + MUTE_MEMBERS(65536) + DEAFEN_MEMBERS(131072) + MOVE_MEMBERS(262144) = 524279
INSERT INTO "roles" ("id", "server_id", "name", "color", "position", "permissions", "is_default", "created_at", "updated_at")
SELECT
    gen_random_uuid()::text,
    s."id",
    'Admin',
    '#5865F2',
    1,
    '524279',
    false,
    NOW(),
    NOW()
FROM "servers" s
WHERE EXISTS (
    SELECT 1 FROM "server_members" sm WHERE sm."server_id" = s."id" AND sm."role" = 'admin'
)
AND NOT EXISTS (
    SELECT 1 FROM "roles" r WHERE r."server_id" = s."id" AND r."name" = 'Admin'
);

-- Seed: Assign Admin role to existing admin members
INSERT INTO "member_roles" ("user_id", "server_id", "role_id")
SELECT
    sm."user_id",
    sm."server_id",
    r."id"
FROM "server_members" sm
JOIN "roles" r ON r."server_id" = sm."server_id" AND r."name" = 'Admin'
WHERE sm."role" = 'admin'
ON CONFLICT DO NOTHING;
