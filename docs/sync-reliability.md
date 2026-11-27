# Cloud sync reliability (FC-005A)

Signed-in saves and deletions are recorded in an append-only per-account localStorage journal before network attempts. Manual Sync now and sign-in retry pending operations. Web Locks serialize retries across tabs. Browsers without Web Locks keep changes locally and display an error instead of starting unsafe retries.

Confirmed deletions leave tombstones so an older cloud listing cannot restore the item. Request completion acknowledges only its own operation key. Account-generation checks discard work after sign-out or account switching.

The status distinguishes confirmed synchronization, pending uploads, conflicts, and failures. Storage failures are errors: export the library before repairing or clearing browser storage.

Same-ID differences are not automatically uploaded over an existing remote record. Review conflicts on the Decks tab to compare local, cloud, and preserved versions and explicitly confirm a selection. A cloud refresh and unchanged local-operation check are required. Keeping local uses an owner-filtered conditional update against the reviewed updated_at timestamp, protecting changes between the refresh and upload. Missing revisions or zero updated rows stop resolution. Successful resolution archives all unique copies before retiring the active conflict; local persistence failures retain the conflict.

Export All now writes a version-2 account-scoped backup of visible libraries, pending operations, conflict and archived versions, baselines, recovery holds, and deletion metadata. It excludes auth sessions and credentials. Keep this file private. Old deck arrays and decks/notes backups remain importable. Version-2 backups can be imported only into the same account (guest backups only in guest mode).

Recovery validates and deduplicates content, creates new IDs, makes restored decks private, and never replays imported operations or deletion tombstones. Recovered signed-in copies stay under durable local holds through normal sync and edits. Only the explicit Upload recovered copies button releases these holds. Import errors report partial storage failures; keep the source backup until recovery is complete. All preserved versions, including previously resolved versions, are recoverable as separate records. Recovery counts exclude duplicate content.

This is browser-local durability, not a server backup or cross-device transaction protocol. Clearing/evicting storage removes pending work; quota failures can prevent durable queuing. Other devices do not share this browser's tombstones. No schema changes are introduced. Conflict replacement relies on the existing updated_at trigger as a revision guard. Real authenticated multi-device behavior, trigger behavior, and database RLS require separate verification. Web Locks are still required for cloud sync and conflict resolution; old pending requests cannot be cancelled server-side after sign-out, but their client results are discarded.

Verification: `node --test test/sync-journal.test.js test/client-privacy.test.js`. These tests use synthetic identities, delayed mocked requests, a shared lock manager, and local storage doubles. They cover cancellation before request start and rejection after a request is genuinely in flight.



