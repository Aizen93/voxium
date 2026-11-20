-- An announcement may name one legal document (privacy, terms or cookies), so
-- a notice of a change can be read in full and open the document it concerns.
-- A nullable column with no default: a catalog change, no table rewrite. Rows
-- already stored keep NULL, which means no document.
ALTER TABLE "announcements" ADD COLUMN "legal_doc" TEXT;
