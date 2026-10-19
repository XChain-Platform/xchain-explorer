# Lane report: cx-red-88e68a76

## Cause of the red
The coverage job failed at `npm run identity:check`: the pin lacked
`test/unit/repo/expected_connection_refusal_noise.test.js`. Commit 06fc62b
(already in the base) refreshes the pin and fixes that.

## Review failure (attempt 4)
The review was right: base commit 7134ec3 ("Sync hub mirror barriers") carried
unrelated production edits to `src/hub/hub_db_sync/barriers/capability_proof.js`
and `oracle_match_call.js`, which the refusal-noise test does not cover. This
lane reverts them (one commit, restoring both files to their 06fc62b content).
No production code is changed relative to 06fc62b.

## Files touched
- src/hub/hub_db_sync/barriers/capability_proof.js (restored)
- src/hub/hub_db_sync/barriers/oracle_match_call.js (restored)

## Verification
- `CI_TIER=full npm run ci:full`: exit 1 here, "MISSING SIBLING
  /home/user/xchain-indexer". The cloud lane has no sibling repos (the 8 in
  .ci-siblings) so the full gate cannot run in this session. NOT verified.
- `npm run identity:check`: 2 differences ("script_category test / test:db:
  pin collected, tree error"), identical on base 7134ec3 and on this branch,
  so the cause is the missing siblings, not the revert. The file_added
  difference from the failing run no longer appears.
- Barrier files are not part of the identity pin hash (result unchanged by the
  revert).

## For the orchestrator
Re-run ci:full on a checkout with siblings to confirm exit 0. If the barrier
sync is wanted, it needs its own row with a test that exercises it.

RUN-COMPLETE 16620de76048d41f989c3f78912de948
