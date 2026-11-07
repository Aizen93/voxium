-- Verify-first registration: no User row exists until the e-mailed code comes
-- back (pending_registrations, one hour), and one mailbox receives at most a
-- few sign-up mails per window (signup_mail_ledger, keyed by a digest of the
-- mailbox like mail_suppressions, never the address). Both tables are additive.
CREATE TABLE "pending_registrations" (
    "id" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "email_canonical" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "code_hash" TEXT NOT NULL,
    "code_expires_at" TIMESTAMP(3) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "resends" INTEGER NOT NULL DEFAULT 0,
    "last_sent_at" TIMESTAMP(3),
    "terms_accepted_at" TIMESTAMP(3) NOT NULL,
    "privacy_accepted_at" TIMESTAMP(3) NOT NULL,
    "ip" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pending_registrations_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "pending_registrations_expires_at_idx" ON "pending_registrations"("expires_at");

CREATE TABLE "signup_mail_ledger" (
    "mailbox_hash" TEXT NOT NULL,
    "window_start_at" TIMESTAMP(3) NOT NULL,
    "sent" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "signup_mail_ledger_pkey" PRIMARY KEY ("mailbox_hash")
);
