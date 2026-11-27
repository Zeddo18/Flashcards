# FC-007A — Database security regression checks (code-only)

**Status:** Proposed hardening SQL, not executed against any real Supabase database.

**Repository:** `Zeddo18/Flashcards`; **snapshot:** read-only catalog inspection of project `csdnqwricljioxrcwmwj`, 28 Nov 2026. No private user rows were retrieved. No production data, credentials, RLS policies, project settings, or permissions were changed. This document is **not** a release authorization or a migration.

## What was observed

- `public.decks`, `public.notes`, and `public.profiles` are RLS-enabled.
- Decks: owners can insert/update/delete, and `SELECT` allows the owner or `is_public = true`. Notes: owner-only read/write. Both UPDATE policies include owner checks in `USING` and `WITH CHECK`.
- `anon` and `authenticated` have **effective** CRUD and also `TRUNCATE`, `REFERENCES`, `TRIGGER`, and `MAINTAIN` privileges on all three tables. Excessive privileges on the study tables are the focus of this proposal; these operations are not governed by row-level filtering. Effective grants were checked with `has_table_privilege`, as well as `pg_class` ACLs.
- `public.touch_updated_at()` is a SECURITY INVOKER trigger function, with a mutable search path and EXECUTE granted to `PUBLIC`, `anon`, `authenticated`; `decks_touch`/`notes_touch` run on `UPDATE`.
- `public.profiles` is used by other application functionality. `public.handle_new_user()` is a SECURITY DEFINER trigger function called by `auth.users` signup; it remains **outside** this change, as does `profiles`.
- Public decks expose the full row to SQL callers, including `user_id` and other fields, regardless of the frontend selecting a subset. Current "shareable by link" semantics are **not** equivalent to unlisted-only access. This requires a separate product/privacy design decision.
- The live database has no recorded migrations. Other advisor findings (leaked-password protection, `handle_new_user` permissions) are unresolved. No authenticated A/B or Data API integration test was performed.

## Files

- `supabase/proposals/fc007a_least_privilege.sql` — REVIEW ONLY; narrow revokes for study tables + timestamp function search path.
- `test/db/fixture.sql` — disposable PostgreSQL 17 schema reproducing the observed **relevant** RLS policies, trigger behavior and broad initial grants. It is a subset, **not** a verified full database snapshot.
- `test/db/security-regression.sql` — executable assertions against two **synthetic** account IDs, including anon/public visibility, CRUD, cross-account denial, ownership reassignment, fixed permissions, and timestamps.
- `.github/workflows/db-security.yml` — GitHub-hosted isolated PostgreSQL 17 service; no Supabase credentials, no app deployment, no production connection. Uses a disposable container **on GitHub Actions only**, not Docker or WSL on the developer's PC. For public repositories, standard GitHub-hosted runners may be available without additional billed usage; check account billing policies.
- `test/db-proposal.test.js` — static guardrails to detect accidental broadening or production-host references.

### How to verify

With Node.js (existing repo CI):

```sh
node scripts/check-syntax.js
node --test test/*.test.js
```

The GitHub `PostgreSQL RLS regression` job creates a fresh PostgreSQL 17 database and runs:

```sh
psql -X -v ON_ERROR_STOP=1 -f test/db/fixture.sql
psql -X -v ON_ERROR_STOP=1 -f supabase/proposals/fc007a_least_privilege.sql
psql -X -v ON_ERROR_STOP=1 -f test/db/security-regression.sql
```

These commands are **only safe when `PGHOST`/`PGDATABASE` refer to the disposable local CI database**. Do not run them against production or an existing database. The fixture contains `CREATE ROLE`, tables and synthetic rows.

## Hardening scope and manual acceptance gate

The proposed SQL retains the preexisting CRUD grants and RLS policies, revokes non-CRUD privileges on `decks` and `notes`, revokes direct timestamp helper EXECUTE, and sets its search path to `pg_catalog`. The migration would affect existing callers, so the synthetic job checks existing timestamp triggers and trigger recreation by the owner. **Passing this fixture is not permission to deploy the SQL.**

Before any production application, require a separate reviewed migration, an isolated Supabase staging test, real authenticated two-account Data API checks (including grant behavior), public-share validation, signup compatibility with `profiles`/`handle_new_user`, rollback, and explicit approval. If creating an isolated Supabase project is blocked by free-plan limits, keep FC-007B blocked rather than modifying production.

## Out-of-scope follow-ups

1. Public-deck column visibility and discoverability; browser queries alone do not protect all columns returned by a direct API client.
2. `profiles`, `handle_new_user`, and the signup flow shared with other apps.
3. Live Supabase Auth and multi-device sync and timestamp checks; not proved by these synthetic tests.
4. Browser storage/Web Locks constraints from FC-005 remain.

References: [Supabase RLS](https://supabase.com/docs/guides/database/postgres/row-level-security), [PostgreSQL 17 RLS](https://www.postgresql.org/docs/17/ddl-rowsecurity.html), [PostgreSQL GRANT](https://www.postgresql.org/docs/17/sql-grant.html).