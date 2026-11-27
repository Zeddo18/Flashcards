-- FC-007A. Disposable PostgreSQL 17 fixture derived from reviewed database
-- catalog metadata; NOT a production dump, and contains no real user data.
\set ON_ERROR_STOP on
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE SCHEMA auth;
GRANT USAGE ON SCHEMA auth TO anon, authenticated;
CREATE TABLE auth.users (id uuid PRIMARY KEY);
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated;

CREATE TABLE public.decks (
 id uuid PRIMARY KEY,
 user_id uuid NOT NULL REFERENCES auth.users(id),
 name text NOT NULL,
 color text,
 cards jsonb NOT NULL DEFAULT '[]'::jsonb,
 is_public boolean NOT NULL DEFAULT false,
 public_slug text UNIQUE,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.notes (
 id uuid PRIMARY KEY,
 user_id uuid NOT NULL REFERENCES auth.users(id),
 title text NOT NULL,
 md text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE FUNCTION public.touch_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END
$$;
CREATE TRIGGER decks_touch BEFORE UPDATE ON public.decks FOR EACH ROW
 EXECUTE FUNCTION public.touch_updated_at();
CREATE TRIGGER notes_touch BEFORE UPDATE ON public.notes FOR EACH ROW
 EXECUTE FUNCTION public.touch_updated_at();
-- Replicate observed original broad grants (not recommended in production).
GRANT ALL PRIVILEGES ON TABLE public.decks, public.notes TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.touch_updated_at() TO PUBLIC, anon, authenticated;

ALTER TABLE public.decks ENABLE ROW LEVEL SECURITY;
CREATE POLICY "delete own" ON public.decks FOR DELETE USING (user_id = auth.uid());
CREATE POLICY "insert own" ON public.decks FOR INSERT WITH CHECK (user_id = auth.uid());
CREATE POLICY "read own or public" ON public.decks FOR SELECT USING
 (user_id = auth.uid() OR is_public = true);
CREATE POLICY "update own" ON public.decks FOR UPDATE
 USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
ALTER TABLE public.notes ENABLE ROW LEVEL SECURITY;
CREATE POLICY "delete own notes" ON public.notes FOR DELETE USING (user_id = auth.uid());
CREATE POLICY "insert own notes" ON public.notes FOR INSERT WITH CHECK (user_id = auth.uid());
CREATE POLICY "read own notes" ON public.notes FOR SELECT USING (user_id = auth.uid());
CREATE POLICY "update own notes" ON public.notes FOR UPDATE
 USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

-- Synthetic fixtures: two account IDs, two private decks, one public deck,
-- and one note each. No user email/password, credentials or real records.
INSERT INTO auth.users(id) VALUES
 ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
 ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
INSERT INTO public.decks (id,user_id,name,cards,is_public,public_slug,updated_at) VALUES
 ('aaaaaaaa-0000-4000-8000-000000000001','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','A private','[]',false,null,'2020-01-01'),
 ('bbbbbbbb-0000-4000-8000-000000000001','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','B private','[]',false,null,'2020-01-01'),
 ('bbbbbbbb-0000-4000-8000-000000000002','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','B shared','[]',true,'only-test','2020-01-01');
INSERT INTO public.notes (id,user_id,title,md,updated_at) VALUES
 ('aaaaaaaa-0000-4000-8000-000000000002','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','A note','A','2020-01-01'),
 ('bbbbbbbb-0000-4000-8000-000000000003','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','B note','B','2020-01-01');