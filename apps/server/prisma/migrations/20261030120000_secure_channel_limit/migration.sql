-- Secure channels get their own per-space limit, apart from max_channels_per_server
-- (which now counts the other channels only). Global default 5; a per-space
-- override is nullable like the other limits.
ALTER TABLE "global_config" ADD COLUMN "max_secure_channels_per_server" INTEGER NOT NULL DEFAULT 5;
ALTER TABLE "server_limits" ADD COLUMN "max_secure_channels_per_server" INTEGER;
