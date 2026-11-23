# Cloud sync reliability (FC-005A)

Signed-in saves and deletions are recorded in an append-only per-account localStorage journal before network attempts. Manual Sync now and sign-in retry pending operations. Web Locks serialize retries across tabs. Browsers without Web Locks keep changes locally and display an error instead of starting unsafe retries.

Confirmed deletions leave tombstones so an older cloud listing cannot restore the item. Request completion acknowledges only its own operation key. Account-generation checks discard work after sign-out or account switching.

The status distinguishes confirmed synchronization, pending uploads, conflicts, and failures. Storage failures are errors: export the library before repairing or clearing browser storage.

Same-ID differences are not automatically uploaded over an existing remote record. Both copies are retained in the account journal and the operation remains pending. Manual conflict resolution and a recovery UI are deferred to FC-005B. Current export-all backups cover the visible library, not journal conflict copies or tombstones. Do not clear browser storage before recovering unresolved versions.

This is browser-local durability, not a server backup or cross-device transaction protocol. Clearing/evicting storage removes pending work; quota failures can prevent durable queuing. Other devices do not share this browser's tombstones. No schema changes or atomic server compare-and-swap are introduced. Real authenticated multi-device behavior and database RLS require separate verification.

Verification: `node --test test/sync-journal.test.js test/client-privacy.test.js`. These tests use synthetic identities, delayed mocked requests, a shared lock manager, and local storage doubles. They cover cancellation before request start and rejection after a request is genuinely in flight.

