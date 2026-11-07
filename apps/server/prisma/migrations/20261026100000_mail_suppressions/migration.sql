-- Mailboxes that asked never to receive Voxium mail again ("Not you? Block
-- Voxium mail to this address"). The key is a digest of the mailbox form of
-- the address, never the address itself (utils/mailSuppression.ts).
CREATE TABLE "mail_suppressions" (
    "mailbox_hash" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mail_suppressions_pkey" PRIMARY KEY ("mailbox_hash")
);
