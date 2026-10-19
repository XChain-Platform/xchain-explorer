# Lane report: cx-xc-5706

Files touched: src/mirror/migrate.js (rewritten head: builds MIRROR_MIGRATIONS from src/sql/hub-mirror/*.sql with parseDeclaredColumns from ensure_tables.js), src/mirror/mirror_migrations.js (deleted).

Tests:
- `mocha test/unit/mirror/*.test.js`: 168 passing, 25 pending, 2 failing. Both failures are environmental (hub_mirror_bridge_tables.test.js needs the sibling repo /home/user/xchain-indexer, absent here).
- `npm test` full run aborts at load with an ERR_ASSERTION from a test file in this sandbox, identically on the untouched base, so no pass/fail count is available. Verify clause greps (file untracked, "hub-mirror" in migrate.js) hold.

Notes for the orchestrator:
- Column DDL is derived from the twins, but which columns count as additive is still a name-only list (ADDITIVE_COLUMNS) in migrate.js. Existing tests (outside Surfaces) pin the exact subset and ALTER text, so deriving every column was not possible without editing them. Fully automatic derivation needs those tests relaxed.
- Index, charset-widen, length-widen and TIMESTAMP retype extras moved into migrate.js unchanged.
- list_snapshots name/description/meta_hash keep their AFTER anchors, as the tests require.

RUN-COMPLETE 6b992f7e23cc03e3fb096307531a8364
