-- FC-008E synthetic RLS tests. Disposable PostgreSQL CI database only.
\set ON_ERROR_STOP on
\echo 'Checking per-device study-history isolation using synthetic accounts.'
DO $$
BEGIN
  IF has_table_privilege('anon','public.study_history_devices','SELECT')
     OR has_table_privilege('anon','public.study_history_devices','INSERT')
     OR has_table_privilege('anon','public.study_history_devices','UPDATE')
     OR has_table_privilege('anon','public.study_history_devices','DELETE') THEN
    RAISE EXCEPTION 'anon has unexpected study-history table access';
  END IF;
  IF NOT has_table_privilege('authenticated','public.study_history_devices','SELECT')
     OR NOT has_table_privilege('authenticated','public.study_history_devices','INSERT')
     OR NOT has_table_privilege('authenticated','public.study_history_devices','UPDATE')
     OR NOT has_table_privilege('authenticated','public.study_history_devices','DELETE') THEN
    RAISE EXCEPTION 'authenticated is missing normal CRUD access';
  END IF;
  IF has_table_privilege('authenticated','public.study_history_devices','TRUNCATE')
     OR has_table_privilege('authenticated','public.study_history_devices','REFERENCES')
     OR has_table_privilege('authenticated','public.study_history_devices','TRIGGER') THEN
    RAISE EXCEPTION 'authenticated has excessive table privileges';
  END IF;
END $$;

INSERT INTO public.study_history_devices(user_id,device_id,history) VALUES
 ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','aaaaaaaa-0000-4000-8000-000000000010',
  '{"version":1,"totals":{"reviews":2},"days":[]}'),
 ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','bbbbbbbb-0000-4000-8000-000000000010',
  '{"version":1,"totals":{"reviews":7},"days":[]}');

SET ROLE anon;
DO $$
BEGIN
  BEGIN
    PERFORM count(*) FROM public.study_history_devices;
    RAISE EXCEPTION 'anon read study history';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    INSERT INTO public.study_history_devices(user_id,device_id,history)
    VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'aaaaaaaa-0000-4000-8000-000000000011','{"version":1}');
    RAISE EXCEPTION 'anon inserted study history';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $$;
RESET ROLE;

SET ROLE authenticated;
SET request.jwt.claim.sub = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
DO $$
DECLARE changed bigint;
BEGIN
  IF (SELECT count(*) FROM public.study_history_devices) <> 1 THEN
    RAISE EXCEPTION 'A must see exactly A device rows';
  END IF;
  IF (SELECT max((history->'totals'->>'reviews')::int)
      FROM public.study_history_devices) <> 2 THEN
    RAISE EXCEPTION 'A received unexpected history payload';
  END IF;
  UPDATE public.study_history_devices
    SET history='{"version":1,"totals":{"reviews":3},"days":[]}'
    WHERE user_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  GET DIAGNOSTICS changed = ROW_COUNT;
  IF changed <> 1 THEN RAISE EXCEPTION 'A could not update own device row'; END IF;
  UPDATE public.study_history_devices
    SET history='{"version":1,"totals":{"reviews":99},"days":[]}'
    WHERE user_id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  GET DIAGNOSTICS changed = ROW_COUNT;
  IF changed <> 0 THEN RAISE EXCEPTION 'A updated B device history'; END IF;
  DELETE FROM public.study_history_devices
    WHERE user_id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  GET DIAGNOSTICS changed = ROW_COUNT;
  IF changed <> 0 THEN RAISE EXCEPTION 'A deleted B device history'; END IF;
  BEGIN
    INSERT INTO public.study_history_devices(user_id,device_id,history)
    VALUES ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      'aaaaaaaa-0000-4000-8000-000000000012','{"version":1}');
    RAISE EXCEPTION 'A forged B ownership';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $$;
RESET ROLE;

SET ROLE authenticated;
SET request.jwt.claim.sub = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
DO $$
BEGIN
  IF (SELECT count(*) FROM public.study_history_devices) <> 1 THEN
    RAISE EXCEPTION 'B must see exactly B device rows';
  END IF;
  IF (SELECT max((history->'totals'->>'reviews')::int)
      FROM public.study_history_devices) <> 7 THEN
    RAISE EXCEPTION 'B history was changed by A';
  END IF;
END $$;
RESET ROLE;

DO $$
BEGIN
  BEGIN
    INSERT INTO public.study_history_devices(user_id,device_id,history)
    VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'aaaaaaaa-0000-4000-8000-000000000013','[]');
    RAISE EXCEPTION 'Non-object history payload was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO public.study_history_devices(user_id,device_id,history)
    VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'aaaaaaaa-0000-4000-8000-000000000014','{"version":2}');
    RAISE EXCEPTION 'Unsupported history version was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $$;
\echo 'FC-008E study-history storage RLS checks PASS.'
