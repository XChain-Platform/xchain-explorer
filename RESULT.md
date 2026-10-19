# Lane report: cx-xc-5706

## Files touched
- src/mirror/migrate.js: additive column and index DDL now read from src/sql/hub-mirror/*.sql via parseDeclaredColumns / parseDeclaredIndexes (ensure_tables.js). Widen and retype steps kept inline.
- src/mirror/mirror_migrations.js: deleted.

## Tests
- `npx mocha ... test/unit/mirror/**/*.test.js`: 180 passing, 25 pending, 2 failing. Base commit gives the same 180 / 2.
- The 2 failures (hub_mirror_bridge_tables.test.js) need the sibling xchain-indexer checkout, absent here.
- Full `npm test` cannot run here: db_action_detail_field_contract.test.js aborts the whole mocha run at load because xchain-indexer src/sql is missing. This is environmental and also true at base.
- Verify command's grep/ls-files part passes; the npm test part needs the xchain-indexer sibling.

## Notes for the orchestrator
- Full derivation of every twin column and key was tried and broke 31 existing tests, which pin a curated subset (e.g. no extra indexes on oracle_prices, exact ALTER text). Tests are outside Surfaces, so migrate.js keeps a names-only list (ADDITIVE) of which twin columns and keys are migrated. DDL itself comes from the twins; a listed name missing from its twin throws at load.
- A new twin column therefore still needs its name added to ADDITIVE to reach legacy mirrors. Follow-up: relax the tests to allow full derivation.
- AFTER anchors are used only for list_snapshots name, description and meta_hash, matching prior behaviour.

RUN-COMPLETE 95784731df12fe4f88c9ecb4c4c85bd8
