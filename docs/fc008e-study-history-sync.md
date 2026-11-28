# FC-008E — Cross-device study-history synchronization

**Status:** Client synchronization implementation merged into `main` in PR #19. The linked Vercel production deployment reached READY for commit `398fe4989ac4c96a42165cf70100117bf02b02b8`. The Supabase migration remains review-only and has NOT been applied to the existing production project. Live authenticated multi-device sync is therefore not verified.

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

The migration `supabase/migrations/202611280001_fc008e_study_history_devices.sql` has not been applied to Supabase. Until that table exists and its Data API is available, the app keeps study history locally and reports a retryable cloud-sync status. Existing deck and note sync is unchanged. No production schema, data, credentials, or settings were modified by this implementation.

## Tests and verification

- `test/study-history-sync.test.js`: device identity, legacy migration, independent-device aggregation, idempotent vector merge, offline retry, account changes, corrupt payload rejection, and backup import.
- `test/study-history-cloud.test.js`: authenticated owner checks, composite-key upsert, deterministic listing, and Data API error handling.
- `test/recovery.test.js` and `test/recovery-ui.test.js`: version 4 source-vector backups and backward compatibility.
- `test/client-privacy.test.js`: stale-account sync protection remains covered.
- GitHub Actions at merged commit: Node suite 183/183 passed; disposable PostgreSQL RLS and FC-008E migration job passed.
- Vercel production deployment for the merge commit: READY. A 30-minute production error/fatal log query returned no matching records; this limited log query is not a substitute for browser or live Supabase verification.

The synthetic SQL workflow proves database RLS behavior, while mocked client tests prove application request construction. Neither claims a live authenticated Supabase round-trip until the production migration is separately approved, applied, and verified.
