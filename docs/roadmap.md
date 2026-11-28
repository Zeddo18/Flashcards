# Flashcards — Master Roadmap and Task Tracker

**Repository:** https://github.com/Zeddo18/Flashcards  
**Production domain:** https://flushcard.vercel.app/  
**Updated:** 28 November 2026  
**Source of truth:** This file is the repository's current task ledger. It records only verified historical tasks and explicitly proposed follow-ups; it does not claim that every future product task has been discovered.

## Progress snapshot

- **Tracked entries:** 9
- **Complete:** 5
- **Partial:** 2
- **Blocked:** 1
- **Not started:** 1
- **Completion:** 5 / 9 = 55.6%

The denominator is the nine entries currently recorded here, not a claim that the entire future product backlog contains only nine tasks. Do not add unverified work to the completed count.

## Task ledger

| ID | Task | Priority | Dependencies | Status | Evidence and remaining checks |
| --- | --- | --- | --- | --- | --- |
| FC-002 | URL-fetch SSRF hardening | High | Existing URL/PDF/document import paths | COMPLETE | SSRF, private-network, redirect, timeout and size protections verified PASS. Regression coverage: `test/fetch-url.test.js`. |
| FC-003 | Gemini API security | High | Existing generation endpoint | COMPLETE | Previously verified syntax checks, existing tests, mocked security/rate-limit tests and real generation checks passed. Preserve the existing rate/concurrency limits and retry responses. |
| FC-004A | Client privacy and account-isolation fixes | Critical | Existing local/cloud sync | COMPLETE | Stale cross-account sync and sign-out cache defects fixed; privacy regression suite passed; PR #9 merged and Vercel READY. Current coverage: `test/client-privacy.test.js`. |
| FC-004B | Live database authorization/RLS verification | Critical | Isolated Supabase staging or equivalent approved authenticated test environment | BLOCKED | Live checks remain unverified because a staging database was unavailable. Synthetic PostgreSQL tests do not replace authenticated Supabase Auth/Data API tests. Do not use production as a test fixture. |
| FC-005A | Durable local sync journal | High | FC-004A account isolation | COMPLETE | Pending saves/deletes, acknowledgements, tombstones, serialized retries and conflict recovery implemented. See `docs/sync-reliability.md`; regression coverage: `test/sync-journal.test.js` and `test/recovery.test.js`. |
| FC-007A | Database least-privilege proposal and synthetic regression checks | High | Read-only schema review | COMPLETE — CODE-ONLY SCOPE | Review-only SQL and disposable PostgreSQL RLS tests are in place. CI applies the proposal only to a synthetic database. No production grants, policies or data were changed. See `docs/fc007a-db-security.md`. |
| FC-008E | Per-device cross-device study-history synchronization | High | FC-005A local durability; study-history table/RLS migration | PARTIAL | Client adapter, per-device source vectors, offline retry, account checks, version-4 backups and synthetic RLS migration tests are merged. PR #19 merged as `398fe4989ac4c96a42165cf70100117bf02b02b8`; production Vercel deployment reached READY. The Supabase migration remains unapplied, and live authenticated multi-device sync is not verified. See `docs/fc008e-study-history-sync.md`. |
| FC-009A | Establish authoritative roadmap and tracker | Medium | Repository discovery and verified task history | PARTIAL | Documentation changes are prepared in PR #20; task completion awaits review and merge. |
| FC-009B | Public-deck privacy and column-exposure audit | High | FC-007A schema observations; read-only inspection of current policies and client/API paths | NOT STARTED | Next eligible task. Audit which columns a direct API client can read for public decks, distinguish frontend projection from database authorization, and produce a privacy-safe design/acceptance plan. Audit only: no production data access, schema changes, grants, RLS changes, or deployment. |

## Current architecture and safety decisions

- The website is a JavaScript application centered on `index.html`, `cloud.js`, and existing Vercel API routes; do not assume a framework migration.
- Supabase, Vercel, authentication and existing cloud sync are already configured. Do not create replacement projects.
- Preserve deck/note sync, local browser data, auth sessions, public sharing behavior and PWA caching.
- Use the existing GitHub Actions Node test suite and disposable PostgreSQL 17 workflow for free/synthetic regression testing, subject to the account's included Actions allowance and billing settings.
- No production Supabase migration, grant change, RLS change or data mutation is authorized by this roadmap.
- Vercel production readiness is not proof of live Supabase sync or browser-level correctness.

## FC-008E production activation boundary

The migration `supabase/migrations/202611280001_fc008e_study_history_devices.sql` remains review-only and has not been applied to the existing Supabase project. Until the table is provisioned and authenticated multi-device behavior is separately verified, study history must remain durable locally and report cloud-sync failures as retryable. Do not claim cross-device study history is live.

## Next eligible task: FC-009B

Perform a read-only public-deck privacy audit. Inspect the current `decks` RLS policies, table grants/columns, public-deck query paths, and any server/API access. Determine exactly what an unauthenticated or authenticated direct Data API client can retrieve for a public deck. Separate facts from assumptions and document a minimal privacy-safe design that preserves intended share-by-link behavior.

**Stop condition:** deliver findings, risk assessment, proposed acceptance criteria and any migration/rollback outline. Do not implement or apply database changes in this task. Obtain a separate approval before changing public-sharing behavior or production database policy.

## Verification rules

- Run focused tests first; run the full suite when a change crosses multiple application areas.
- For database work, distinguish synthetic PostgreSQL coverage from live Supabase Auth/Data API verification.
- For Vercel, distinguish PR checks, preview deployments, and the production deployment.
- Never report a production behavior as verified unless it was actually tested.
- Update this ledger after each bounded task. Do not count subtasks twice.
