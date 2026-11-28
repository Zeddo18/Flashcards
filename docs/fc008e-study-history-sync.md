# FC-008E — Cross-device study-history synchronization

**Status:** Client synchronization adapter and automated tests are implemented in this branch. The database migration is still review-only and has NOT been applied to the production Supabase project.

## How synchronization works

- Each browser installation receives a persistent UUID stored locally.
- Each signed-in account keeps an isolated source-history map in local storage.
- A device increments only its own source history. Other devices' source histories are not folded into that local counter.
- Each cloud row stores a version-1 source vector. Replicated copies of the same source are merged with the existing idempotent max-counter merge; independent device sources are summed for the analytics display.
- Every device upserts only its own (user_id, device_id) row. The table's RLS policies enforce account ownership.
- Web Locks serialize local source updates and cloud sync across tabs. If Web Locks are unavailable, local study continues, but cloud study-history sync is held back.
- Failed/offline requests do not discard local progress. The next sign-in, manual Sync, or browser online event retries the latest durable source vector.
- The existing pre-FC-008E account history is migrated into the current browser's source without deleting the old local value.
- Version 4 backups include source vectors. Version 2 and 3 backups remain supported; old history-only backups merge into the current device source.

## No-cost test environment

The existing GitHub Actions PostgreSQL 17 service is disposable and uses synthetic accounts and credentials. It runs the migration and RLS SQL regression checks without a Supabase branch or production connection. Usage is subject to the repository's included Actions allowance and account billing settings; no new paid service is added.

## Production activation boundary

The migration supabase/migrations/202611280001_fc008e_study_history_devices.sql has not been applied to Supabase. Until that table exists and its Data API is available, the app keeps study history locally and reports a retryable cloud-sync status. Existing deck and note sync is unchanged. No production schema, data, credentials, or settings were modified by this implementation.

## Tests

- test/study-history-sync.test.js: device identity, legacy migration, independent-device aggregation, idempotent vector merge, offline retry, account changes, corrupt payload rejection, and backup import.
- test/study-history-cloud.test.js: authenticated owner checks, composite-key upsert, deterministic listing, and Data API error handling.
- test/recovery.test.js and test/recovery-ui.test.js: version 4 source-vector backups and backward compatibility.
- test/client-privacy.test.js: stale-account sync protection remains covered.

The synthetic SQL workflow proves database RLS behavior, while mocked client tests prove application request construction. Neither claims a live authenticated Supabase round-trip until the production migration is explicitly applied and verified.
