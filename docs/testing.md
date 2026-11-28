# Automated checks

Run from the repository root with Node.js 24 LTS (no install step):

\`\`\`
node scripts/check-syntax.js
node --test test/*.test.js
\`\`\`

The syntax command checks root JavaScript and all JavaScript under api, lib,
scripts, and test. It also checks executable inline scripts in index.html,
using classic or module syntax as appropriate. External scripts and non-JavaScript
data blocks (including JSON, JSON-LD, import maps and speculation rules) are skipped.
The lightweight HTML scanner is intended for this static page, not as a general
HTML validator. Browser runtime behavior and downloaded CDN code are not checked.

GitHub Actions runs both commands on pull requests and pushes to main. The
Node tests job uses read-only repository permissions and pinned official actions.
It uses no application credentials, database, Docker, dependency installation or
deployment step. Vercel's existing Git deployment behavior is unchanged.
To enforce the job as a merge gate, a repository administrator must separately
select Node tests as a required status check in the branch rules.

The separate PostgreSQL RLS regression job uses a disposable PostgreSQL 17
service on GitHub-hosted Actions. It runs the synthetic fixture, the FC-007A
review-only SQL proposal, the FC-008E study-history migration, and account-isolation
assertions. It does not connect to Supabase or use production credentials. The
job is subject to the repository's included GitHub Actions allowance and account
billing settings.

Existing regression coverage:

| Area | Test file |
| --- | --- |
| URL import, SSRF, redirects, limits and safe errors | test/fetch-url.test.js |
| Notes API modes, validation, quotas and security headers | test/notes-security.test.js |
| Account changes, stale sync/generation and guest behavior | test/client-privacy.test.js |
| Durable retries, tombstones, serialization and public sharing contracts | test/sync-journal.test.js |
| Manual conflicts, stale resolutions, backup and recovery | test/recovery.test.js |
| Recovery UI, account switches, study-history backup/merge and export | test/recovery-ui.test.js |
| Study history, daily activity, streaks and per-deck analytics | test/study-analytics.test.js |
| Executable inline script classification and syntax-check behavior | test/syntax-check.test.js |

Tests use synthetic data and mocked cloud/network responses. They do not verify
live Gemini generation, real Supabase RLS or authenticated multi-device behavior.
Public sharing coverage checks the client query contract, not production policies.
