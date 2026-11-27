-- FC-007A: runs against a disposable PG17 database ONLY. Never production.
\set ON_ERROR_STOP on
\echo 'Checking reviewed hardening behavior against synthetic users.'

-- Permission and function contract (these checks execute as the test admin).
DO $$
DECLARE role_name text; table_name text;
BEGIN
 FOR role_name IN SELECT unnest(ARRAY['anon','authenticated']) LOOP
  FOR table_name IN SELECT unnest(ARRAY['decks','notes']) LOOP
   IF NOT has_table_privilege(role_name, 'public.'||table_name, 'SELECT')
      OR NOT has_table_privilege(role_name, 'public.'||table_name, 'INSERT')
      OR NOT has_table_privilege(role_name, 'public.'||table_name, 'UPDATE')
      OR NOT has_table_privilege(role_name, 'public.'||table_name, 'DELETE') THEN
    RAISE EXCEPTION 'Expected normal CRUD unchanged for %.%',role_name,table_name;
   END IF;
   IF has_table_privilege(role_name, 'public.'||table_name, 'TRUNCATE')
      OR has_table_privilege(role_name, 'public.'||table_name, 'REFERENCES')
      OR has_table_privilege(role_name, 'public.'||table_name, 'TRIGGER')
      OR has_table_privilege(role_name, 'public.'||table_name, 'MAINTAIN') THEN
    RAISE EXCEPTION 'Excessive privilege remains for %.%',role_name,table_name;
   END IF;
  END LOOP;
  IF has_function_privilege(role_name, 'public.touch_updated_at()', 'EXECUTE') THEN
   RAISE EXCEPTION 'Client can invoke the timestamp function: %', role_name;
  END IF;
 END LOOP;
 IF has_function_privilege('postgres','public.touch_updated_at()','EXECUTE') IS NOT TRUE THEN
  RAISE EXCEPTION 'Database owner must retain trigger function execute';
 END IF;
 IF (SELECT proconfig IS NULL OR NOT ('search_path=pg_catalog'=ANY(proconfig))
   FROM pg_proc WHERE oid='public.touch_updated_at()'::regprocedure) THEN
  RAISE EXCEPTION 'timestamp function search_path is not fixed';
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='decks' AND
   policyname='update own' AND qual LIKE '%auth.uid()%' AND with_check LIKE '%auth.uid()%') THEN
  RAISE EXCEPTION 'Deck ownership policy weakened';
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='notes' AND
   policyname='update own notes' AND qual LIKE '%auth.uid()%' AND with_check LIKE '%auth.uid()%') THEN
  RAISE EXCEPTION 'Note ownership policy weakened';
 END IF;
END $$;

SET ROLE anon;
DO $$ BEGIN
 IF (SELECT count(*) FROM public.decks) <> 1 THEN
  RAISE EXCEPTION 'Anonymous user must see only public deck';
 END IF;
 IF (SELECT count(*) FROM public.notes) <> 0 THEN
  RAISE EXCEPTION 'Anonymous user saw private notes';
 END IF;
END $$;
RESET ROLE;

SET ROLE authenticated;
SET request.jwt.claim.sub = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
DO $$ BEGIN
 IF (SELECT count(*) FROM public.decks) <> 2 THEN
  RAISE EXCEPTION 'A must see its private deck plus B public deck, not B private';
 END IF;
 IF (SELECT count(*) FROM public.notes) <> 1 THEN
  RAISE EXCEPTION 'A must see only A note';
 END IF;
END $$;

-- A can INSERT own data but cannot forge B's ownership.
INSERT INTO public.decks(id,user_id,name)
 VALUES ('aaaaaaaa-0000-4000-8000-000000000004', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'A new');
INSERT INTO public.notes(id,user_id,title,md)
 VALUES ('aaaaaaaa-0000-4000-8000-000000000005', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'A new','text');
DO $$ BEGIN
 BEGIN
  INSERT INTO public.decks(id,user_id,name)
   VALUES ('aaaaaaaa-0000-4000-8000-000000000006','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','spoof');
  RAISE EXCEPTION 'Owner spoof deck INSERT was permitted';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN
  INSERT INTO public.notes(id,user_id,title,md)
   VALUES ('aaaaaaaa-0000-4000-8000-000000000007','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','spoof','text');
  RAISE EXCEPTION 'Owner spoof note INSERT was permitted';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;

-- Existing timestamp triggers should still work after EXECUTE was revoked.
UPDATE public.decks SET name='A edited' WHERE id='aaaaaaaa-0000-4000-8000-000000000001';
UPDATE public.notes SET title='A edited' WHERE id='aaaaaaaa-0000-4000-8000-000000000002';
DO $$
DECLARE changed bigint;
BEGIN
 IF (SELECT updated_at FROM public.decks
   WHERE id='aaaaaaaa-0000-4000-8000-000000000001') <= '2020-01-01'::timestamptz THEN
  RAISE EXCEPTION 'Deck updated_at did not advance';
 END IF;
 IF (SELECT updated_at FROM public.notes
   WHERE id='aaaaaaaa-0000-4000-8000-000000000002') <= '2020-01-01'::timestamptz THEN
  RAISE EXCEPTION 'Note updated_at did not advance';
 END IF;
 UPDATE public.decks SET name='Illegal B edit'
   WHERE id='bbbbbbbb-0000-4000-8000-000000000001';
 GET DIAGNOSTICS changed = ROW_COUNT;
 IF changed <> 0 THEN RAISE EXCEPTION 'A updated B private deck'; END IF;
 UPDATE public.notes SET title='Illegal B note edit'
   WHERE id='bbbbbbbb-0000-4000-8000-000000000003';
 GET DIAGNOSTICS changed = ROW_COUNT;
 IF changed <> 0 THEN RAISE EXCEPTION 'A updated B private note'; END IF;
 DELETE FROM public.decks WHERE id='bbbbbbbb-0000-4000-8000-000000000001';
 GET DIAGNOSTICS changed = ROW_COUNT;
 IF changed <> 0 THEN RAISE EXCEPTION 'A deleted B private deck'; END IF;
 DELETE FROM public.notes WHERE id='bbbbbbbb-0000-4000-8000-000000000003';
 GET DIAGNOSTICS changed = ROW_COUNT;
 IF changed <> 0 THEN RAISE EXCEPTION 'A deleted B private note'; END IF;
 BEGIN
  UPDATE public.decks SET user_id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
   WHERE id='aaaaaaaa-0000-4000-8000-000000000001';
  RAISE EXCEPTION 'Deck ownership changed';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN
  UPDATE public.notes SET user_id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
   WHERE id='aaaaaaaa-0000-4000-8000-000000000002';
  RAISE EXCEPTION 'Note ownership changed';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
RESET ROLE;

SET ROLE authenticated;
SET request.jwt.claim.sub = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
DO $$ BEGIN
 IF (SELECT count(*) FROM public.decks) <> 2 THEN
  RAISE EXCEPTION 'B must see B private and public, not A private';
 END IF;
 IF (SELECT count(*) FROM public.notes) <> 1 THEN
  RAISE EXCEPTION 'B must see only B note';
 END IF;
END $$;
RESET ROLE;

-- Owner-level trigger recreation is required to remain possible.
CREATE TRIGGER deck_touch_test AFTER UPDATE ON public.decks FOR EACH ROW
 EXECUTE FUNCTION public.touch_updated_at();
DROP TRIGGER deck_touch_test ON public.decks;
\echo 'FC-007A synthetic PostgreSQL security checks PASS.'