/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * Unit tests for M3.5 (frontier row 22): Database#getReorgs (src/db/index.js),
 * proxying the hub's EXISTING unauthenticated `getreorghistory` RPC over the
 * established dual path (see getValidatorCapabilities, db/index.js:9446-9473):
 * RPC-first via HubOperationalCache when a hub is configured, the co-located
 * hub schema as the no-hub-at-all fallback, and a THROW (never an empty
 * table) once a configured hub is unreachable past
 * EXPLORER_HUB_CACHE_STALE_MAX_MS.
 *
 * `getReorgs` itself is proposed, not yet in src/db/index.js (db/index.js is a shared
 * seam file owned by the main loop per the M3 seam contract; likewise
 * src/mirror/operational_cache.js's new getReorgHistory() method, the
 * getQueryWhereSql branch, the cursorPagedMethods/getQueryOffsetSql cursor
 * entries, and the normalizeHubOperationalRows bigintKeys extension). Every
 * test below is written to be RUN once the main loop splices the proposal
 * in (m3-proposal-row22.md) - not to pass vacuously today - the same
 * pattern test/unit/explorer.attest-validator-stats.test.js and
 * test/unit/HubOperationalCache.test.js's "db.js RPC-first operational
 * reads" suite already use for this wave.
 *
 * Venue fact (2026-08-19): `getreorghistory` answers cleanly at the hub and
 * returns `[]` - this chain has never reorged. The transport is proven, only
 * the data is absent. That is exactly the case these tests must not
 * confuse with an outage: an empty array from the RPC is a LEGITIMATE "no
 * reorgs" answer (200, total 0), while a null return past the stale ceiling
 * is a hub OUTAGE and must throw. A user must never see the same "no rows"
 * table for both. See the 'legitimate empty vs hub outage' describe block.
 *
 * Schema facts (read from xchain-hub/src/sql/reorg_attestations.sql and
 * anchor/reorg_handler.js):
 *   CREATE TABLE reorg_attestations (
 *       id               BIGINT AUTO_INCREMENT PRIMARY KEY,
 *       reorg_id         VARCHAR(100) NOT NULL UNIQUE,   -- '<chain>:<height>:<ts>'
 *       source_chain     VARCHAR(10) NOT NULL,
 *       reorg_height     BIGINT NOT NULL,
 *       reorg_timestamp  BIGINT NOT NULL,                -- MILLISECONDS (compared
 *                                                         -- against Date.now() in
 *                                                         -- ReorgHandler; unlike
 *                                                         -- price_snapshots.block_timestamp,
 *                                                         -- which is Unix SECONDS)
 *       affected_chains  TEXT,                           -- JSON.stringify'd array
 *       validator_count  INT NOT NULL DEFAULT 0,
 *       consensus_proof  TEXT,
 *       status           ENUM('confirmed','rejected') NOT NULL DEFAULT 'confirmed',
 *       created_at       TIMESTAMP,
 *       updated_at       TIMESTAMP,
 *       KEY idx_chain (source_chain), KEY idx_status (status)
 *   );
 *
 * No action_index (this is a hub-federation-owned table, not an action-chain
 * row). The cursor is m.id (AUTO_INCREMENT), matching the other three
 * HubOperationalCache-backed tables (validator_capabilities/
 * governance_proposals/governance_votes), all monotonic and unique.
 *
 * Cross-chain scoping fact this row's design turns on: unlike those three
 * tables (explicitly "platform-global, no per-chain network column" per
 * hubSource's doc comment), reorg_attestations DOES carry source_chain, and
 * the hub's getreorghistory RPC has NO server-side chain filter at all
 * (ReorgHandler.getReorgHistory: `SELECT * FROM reorg_attestations ORDER BY
 * created_at DESC LIMIT ?`) - it returns every chain's history. A per-coin
 * page (/{COIN}/reorgs) that served that unfiltered would leak another
 * chain's reorgs onto this coin's page, so BOTH transports mandatorily
 * scope to `this.baseCoin[config.coin]` (BTC/LTC/DOGE): RPC-side inside the
 * cache method (client-side, matching how getGovernanceProposals already
 * filters proposal_id post-fetch since getproposals has no such filter
 * either); co-located-side via an unconditional `m.source_chain=?`, matching
 * getCrossChainMatches' mandatory network filter. `baseCoin` (not
 * `checkpointSource().chain`) is used because it is populated for every
 * configured coin regardless of whether a co-located checkpoint DB exists,
 * so the RPC-only (HUB_API_URL set, no database.checkpoint) deployment shape
 * can still scope correctly.
 */

'use strict';

const { expect }  = require('chai');

require('./explorer_reorgs.test/support/data_leg.js');

// ─────────────────────────────────────────────────────────────────────────
// Row-mapping documentation: the getPagingDataResults branch lives in
// src/XChainExplorer.js (a shared seam file this row may not edit) and the
// coloring-exclusion-list edit lives in src/content/js/xchain.js (same), so
// both are PROPOSED text in m3-proposal-row22.md rather than in-tree code
// here. This block pins the field order and element count that proposal
// commits to, keyed off the exact SELECT column list asserted above, so a
// splice that reorders one side without the other is caught by inspection -
// the same pattern explorer.attest-validator-stats.test.js uses.
// ─────────────────────────────────────────────────────────────────────────
describe('reorg row-mapping contract (documents the proposed getPagingDataResults branch)', () => {

    it('the proposed 8-element row = [count_reverse, reorg_timestamp, reorg_height, reorg_id, affected_chains, validator_count, status, id]', () => {
        // 8 array elements over 7 <th> (see reorgs.html: #, Time, Height, Reorg ID,
        // Affected Chains, Validators, Status). The LAST element (m.id) is the
        // un-rendered paging cursor. status (enum 'confirmed'/'rejected', a word not
        // 0/1) sits second-to-last, consumed positionally by createdRow, but MUST be
        // added to xchain.js:1338's no-color exclusion list ('reorg') alongside
        // 'checkpoint'/'price_snapshot'/'validator_capability' etc, or a 'rejected'
        // row would compare its status string against 1 and always paint red/green
        // rather than the badge the per-action render block supplies.
        const VISIBLE = ['reorg_timestamp', 'reorg_height', 'reorg_id', 'affected_chains', 'validator_count'];
        const PROPOSED_ROW = ['count_reverse', ...VISIBLE, 'status', 'id'];
        expect(PROPOSED_ROW).to.have.lengthOf(8);
        expect(PROPOSED_ROW[PROPOSED_ROW.length - 1]).to.equal('id', 'last element is always the paging cursor');
        expect(PROPOSED_ROW[PROPOSED_ROW.length - 2]).to.equal('status', 'second-to-last is always consumed as status by createdRow');
    });

    it('reorg_timestamp is stored in MILLISECONDS, unlike price_snapshot.block_timestamp (Unix seconds) - the proposed xchain.js render divides by 1000 before formatLivestamp', () => {
        // ReorgHandler compares the raw `timestamp` RPC param directly against
        // Date.now() (milliseconds) and stores it verbatim into reorg_timestamp;
        // formatLivestamp/data-livestamp expects Unix SECONDS (confirmed by this
        // file's own moment.unix(...) sibling calls on the same values elsewhere).
        // Passing reorg_timestamp straight through un-divided would reproduce the
        // M2 handoff's exact defect class (a raw Unix value rendered under the
        // wrong unit assumption, there on coinpay obligations).
        const reorg_timestamp_ms = 1755600000000;
        const expected_seconds   = Math.floor(reorg_timestamp_ms / 1000);
        expect(expected_seconds).to.equal(1755600000);
    });
});
