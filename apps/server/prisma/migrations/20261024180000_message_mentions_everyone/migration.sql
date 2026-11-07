-- The MENTION_EVERYONE permission existed with nothing checking it. A message
-- that contains @everyone, sent (or last edited) by a member holding the
-- permission in that channel, is flagged here by the server; clients render
-- the token as a mention and notify every reader. Existing rows: false.
ALTER TABLE "messages" ADD COLUMN "mentions_everyone" BOOLEAN NOT NULL DEFAULT false;
