-- Registration consent (CNIL/GDPR): the moment each legal document was
-- accepted at signup, recorded so consent is provable rather than assumed.
-- Nullable: accounts created before the consent step existed have no record.
ALTER TABLE "users" ADD COLUMN "terms_accepted_at" TIMESTAMP(3);
ALTER TABLE "users" ADD COLUMN "privacy_accepted_at" TIMESTAMP(3);
