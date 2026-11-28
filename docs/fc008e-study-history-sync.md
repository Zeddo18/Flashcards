# FC-008E — Cross-device study-history storage foundation

**Status:** Code-only migration and synthetic PostgreSQL regression tests. The migration has NOT been applied to any Supabase project.

## No-cost test environment

This task reuses the repository's existing GitHub Actions PostgreSQL RLS regression workflow. GitHub Actions starts an ephemeral PostgreSQL 17 service with synthetic credentials and synthetic users, applies the fixture and proposed migrations, then runs SQL assertions. The service is discarded with the workflow job. No Supabase development branch, production connection string, Docker installation on the user's PC, or application credentials are needed.

Usage is subject to the repository's GitHub Actions allowance and account billing settings; this change adds no new paid service or Supabase compute.

## Storage design

public.study_history_devices stores one analytics-history snapshot per (user_id, device_id). Each row contains a version-1 FCStudyAnalytics JSON object and an update timestamp. A composite key permits one signed-in account to sync several browser installations without one device overwriting another device's row.

The table references auth.users with ON DELETE CASCADE, has RLS enabled, denies PUBLIC and anon table privileges, and grants CRUD only to authenticated. Four policies restrict SELECT/INSERT/UPDATE/DELETE to user_id = auth.uid(). The database rejects non-object and unsupported-version history payloads.

## Current scope

- Added migration proposal: supabase/migrations/202611280001_fc008e_study_history_devices.sql.
- Added synthetic SQL regression: test/db/study-history-sync.sql.
- Extended the existing disposable PostgreSQL workflow to apply and test the migration.
- Added static guardrails in test/db-proposal.test.js.

This is the database foundation only. The browser-to-cloud client adapter, per-device local counters, idempotent merge strategy, offline queue/retry behavior, and real authenticated Data API tests remain subsequent implementation work. No production database migration or records were changed.
