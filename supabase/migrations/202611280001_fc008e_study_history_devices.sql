-- FC-008E: per-device study-history storage.
-- Review migration only; it has NOT been applied to production.
BEGIN;
CREATE TABLE public.study_history_devices (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  device_id uuid NOT NULL,
  history jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT study_history_devices_pkey PRIMARY KEY (user_id, device_id),
  CONSTRAINT study_history_devices_history_object CHECK (
    jsonb_typeof(history) = 'object' AND history->>'version' = '1'
  )
);
ALTER TABLE public.study_history_devices ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE public.study_history_devices
  FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE public.study_history_devices TO authenticated;
CREATE POLICY "read own study history devices"
  ON public.study_history_devices FOR SELECT TO authenticated
  USING (user_id = auth.uid());
CREATE POLICY "insert own study history devices"
  ON public.study_history_devices FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());
CREATE POLICY "update own study history devices"
  ON public.study_history_devices FOR UPDATE TO authenticated
  USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
CREATE POLICY "delete own study history devices"
  ON public.study_history_devices FOR DELETE TO authenticated
  USING (user_id = auth.uid());
COMMIT;
