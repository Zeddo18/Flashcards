-- FC-007A REVIEW ONLY. Never run this file against production without separate approval.
-- Scope: public.decks, public.notes, and public.touch_updated_at() ONLY.
-- Based on a read-only inspection of the Flashcards production database on 2026-11-28.
-- No policy rewrites, no table/data modifications, no changes to shared profiles/signup.
BEGIN;

REVOKE TRUNCATE, REFERENCES, TRIGGER, MAINTAIN
  ON TABLE public.decks, public.notes FROM anon, authenticated;

-- Existing BEFORE UPDATE triggers keep working; tested in disposable PostgreSQL 17.
REVOKE EXECUTE ON FUNCTION public.touch_updated_at()
  FROM PUBLIC, anon, authenticated;

-- Body only sets NEW.updated_at = now(); pg_catalog resolves the built-in.
ALTER FUNCTION public.touch_updated_at() SET search_path TO pg_catalog;

COMMIT;