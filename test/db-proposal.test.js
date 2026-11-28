'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');
const proposal = read('supabase/proposals/fc007a_least_privilege.sql');
const fixture = read('test/db/fixture.sql');
const regressions = read('test/db/security-regression.sql');
const workflow = read('.github/workflows/db-security.yml');
const studyMigration = read('supabase/migrations/202611280001_fc008e_study_history_devices.sql');
const studyTests = read('test/db/study-history-sync.sql');

test('hardening SQL is explicitly marked review-only and narrowly scoped', () => {
  assert.match(proposal, /REVIEW ONLY/);
  assert.match(proposal, /REVOKE TRUNCATE, REFERENCES, TRIGGER, MAINTAIN[\s\S]*public\.decks, public\.notes FROM anon, authenticated/i);
  assert.match(proposal, /REVOKE EXECUTE ON FUNCTION public\.touch_updated_at\(\)/i);
  assert.match(proposal, /ALTER FUNCTION public\.touch_updated_at\(\) SET search_path TO pg_catalog/i);
  const statements = proposal.split('\n').filter(line => !line.trim().startsWith('--')).join('\n');
  assert.doesNotMatch(statements, /\b(?:DROP|DELETE|UPDATE|INSERT|CREATE|ALTER\s+TABLE|ALTER\s+POLICY|GRANT|REVOKE\s+ALL)\b/i);
  assert.doesNotMatch(proposal, /\bpublic\.profiles\b|\bhandle_new_user\s*\(/i);
});

test('disposable database harness does not reference production credentials or host', () => {
  for (const text of [proposal, fixture, regressions, workflow, studyMigration, studyTests]) {
    assert.doesNotMatch(text, /csdnqwricljioxrcwmwj|supabase\.co|service_role\b|eyJhbGci|password=.*(?:real|prod)/i);
  }
  assert.match(workflow, /postgres:17/);
  assert.match(workflow, /permissions:\s*\n\s*contents: read/);
  assert.match(workflow, /-f test\/db\/fixture\.sql/);
  assert.match(workflow, /-f supabase\/proposals\/fc007a_least_privilege\.sql/);
  assert.match(workflow, /-f test\/db\/security-regression\.sql/);
  assert.match(workflow, /-f supabase\/migrations\/202611280001_fc008e_study_history_devices\.sql/);
  assert.match(workflow, /-f test\/db\/study-history-sync\.sql/);
});

test('real policy fixture contains ownership checks and deliberately synthetic users', () => {
  assert.match(fixture, /CREATE POLICY "update own"[\s\S]*WITH CHECK \(user_id = auth\.uid\(\)\)/);
  assert.match(fixture, /CREATE POLICY "update own notes"[\s\S]*WITH CHECK \(user_id = auth\.uid\(\)\)/);
  assert.match(fixture, /ENABLE ROW LEVEL SECURITY/g);
  assert.match(fixture, /aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/);
  assert.match(fixture, /bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/);
});

test('regression suite checks both user directions, public visibility and timestamp triggers', () => {
  assert.match(regressions, /SET ROLE anon/);
  assert.match(regressions, /SET ROLE authenticated/g);
  assert.match(regressions, /A updated B private deck/);
  assert.match(regressions, /A deleted B private note/);
  assert.match(regressions, /B must see B private and public/);
  assert.match(regressions, /Timestamp triggers|timestamp triggers/i);
  assert.match(regressions, /CREATE TRIGGER deck_touch_test/);
});

test('FC-008E migration is isolated to per-device study history with owner RLS', () => {
  assert.match(studyMigration, /CREATE TABLE public\.study_history_devices/);
  assert.match(studyMigration, /PRIMARY KEY \(user_id, device_id\)/);
  assert.match(studyMigration, /REFERENCES auth\.users\(id\) ON DELETE CASCADE/);
  assert.match(studyMigration, /ENABLE ROW LEVEL SECURITY/);
  assert.match(studyMigration, /REVOKE ALL PRIVILEGES[\s\S]*FROM PUBLIC, anon, authenticated/);
  assert.match(studyMigration, /GRANT SELECT, INSERT, UPDATE, DELETE[\s\S]*TO authenticated/);
  assert.equal((studyMigration.match(/USING \(user_id = auth\.uid\(\)\)/g) || []).length, 2);
  assert.equal((studyMigration.match(/WITH CHECK \(user_id = auth\.uid\(\)\)/g) || []).length, 2);
  assert.doesNotMatch(studyMigration, /public\.decks|public\.notes|public\.profiles|DROP TABLE|TRUNCATE TABLE/i);
});

test('FC-008E SQL regression checks anon denial and two-account device isolation', () => {
  assert.match(studyTests, /SET ROLE anon/);
  assert.match(studyTests, /SET ROLE authenticated/g);
  assert.match(studyTests, /A forged B ownership/);
  assert.match(studyTests, /A updated B device history/);
  assert.match(studyTests, /B history was changed by A/);
});
