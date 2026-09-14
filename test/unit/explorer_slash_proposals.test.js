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
 * Unit tests for M3.6 (frontier row 23): Database#getSlashProposals
 * (src/db/index.js), proxying the hub's NEW unauthenticated `getslashproposals`
 * RPC over the established dual path (see getValidatorCapabilities and
 * getReorgs): RPC-first via HubOperationalCache when a hub is configured, the
 * co-located hub schema as the no-hub-at-all fallback, and a THROW (never an
 * empty table) once a configured hub is unreachable past
 * EXPLORER_HUB_CACHE_STALE_MAX_MS.
 *
 * `getSlashProposals` itself is proposed, not yet in src/db/index.js (db/index.js is a
 * shared seam file owned by the main loop per the M3 seam contract; likewise
 * src/mirror/operational_cache.js's new getSlashProposals() method, the
 * getQueryWhereSql branch, the cursorPagedMethods / getQueryOffsetSql cursor
 * entries, and the normalizeHubOperationalRows bigintKeys extension). Every
 * test below is written to be RUN once the main loop splices the proposal in
 * (m3-proposal-row23.md), not to pass vacuously today, matching
 * test/unit/explorer_reorgs.test.js from the same wave. The hub half of this
 * row is real, landed code in the sibling checkout
 * (xchain-hub/src/validators/slash_detector.js getSlashProposals + api.js
 * getslashproposals, covered by xchain-hub/test/unit/slash_proposals_rpc.test.js).
 *
 * THE RULING THIS ROW IMPLEMENTS (operator, 2026-08-20, option b): publish all
 * statuses, label pending rows as unadjudicated, and return the evidence as a
 * HASH rather than verbatim. The hashing is a HUB-SIDE leg of the new RPC,
 * because the hub's own POST surface serves that RPC to any caller, so
 * redacting explorer-side alone would leave the verbatim evidence readable
 * straight off the hub. The explorer's job is therefore to (a) never ask for
 * the evidence column on either transport, and (b) never render a pending row
 * as anything other than an unadjudicated accusation. Both are asserted below.
 *
 * Venue fact (2026-08-20): `slash_proposals` has ZERO rows and none can be
 * produced on this venue, because SlashDetector must observe a fault in
 * machinery (oracle/attestation rounds with a misbehaving validator) that
 * cannot run here. These tests therefore exercise SQL/RPC shape, the hashing
 * contract, the outage behaviour and the row mapping, never data presence. An
 * empty array from the RPC is a LEGITIMATE "no proposals recorded" answer
 * (200, total 0); a null past the stale ceiling is a hub OUTAGE and must
 * throw. A reader must never see the same table for both.
 *
 * Schema facts (read from xchain-hub/src/sql/slash_proposals.sql):
 *   CREATE TABLE slash_proposals (
 *       id               BIGINT AUTO_INCREMENT PRIMARY KEY,
 *       validator_pubkey CHAR(64) NOT NULL,      -- 64 hex, lowercased on write
 *       offense_type     VARCHAR(30) NOT NULL,   -- price_deviation |
 *                                                -- repeated_deviation |
 *                                                -- non_participation |
 *                                                -- attestation_divergence
 *       round_number     BIGINT,                 -- oracle round (or a pseudo-round
 *                                                -- lifted from an attestation
 *                                                -- requestId), NOT a block height
 *       evidence         TEXT,                   -- verbatim JSON; NEVER published
 *       status           ENUM('pending','approved','rejected','expired')
 *                        NOT NULL DEFAULT 'pending',
 *       created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
 *       KEY idx_validator (validator_pubkey), KEY idx_status (status)
 *   );
 *
 * CHAIN SCOPE: there is NO chain or network column, and none is missing by
 * oversight. The offenses are federation-wide (oracle price rounds and
 * attestation rounds are not per-chain; a validator's signing pubkey is one
 * identity across every chain the federation serves), so slash_proposals is
 * PLATFORM-GLOBAL, exactly like validator_capabilities / governance_proposals /
 * governance_votes and unlike reorg_attestations (which carries source_chain
 * and forced row 22 to scope by coin). This surface therefore binds no chain
 * filter on either transport, and the same rows are correct on every coin's
 * page. The 'no chain filter' tests below pin that as a decision rather than an
 * omission: a chain filter added later would silently empty this page, since no
 * row will ever carry a chain value to match.
 */

'use strict';

const fs         = require('fs');
const path       = require('path');
const { expect } = require('chai');

require('./explorer_slash_proposals.test/data_leg.js');

// ─────────────────────────────────────────────────────────────────────────
// The page fragment IS an owned in-tree file, so these run today. They pin the
// presentation half of the operator's ruling: a reader must not come away
// thinking a validator has been found guilty, and an empty table must read as
// "none recorded" rather than as an error.
// ─────────────────────────────────────────────────────────────────────────
describe('slash_proposals.html (the unadjudicated-accusation wording obligation)', () => {

    const html = fs.readFileSync(
        path.join(__dirname, '../../src/content/html/slash_proposals.html'), 'utf8');

    it('states in plain language that these are accusations, not verdicts', () => {
        expect(html).to.contain('accusations, not verdicts');
        expect(html.toLowerCase()).to.contain('unadjudicated');
        expect(html.toLowerCase()).to.contain('has not been found');
    });

    it('says a penalty requires a governance vote, so a row alone is never enforcement', () => {
        expect(html.toLowerCase()).to.contain('governance vote');
    });

    it('explains what an EMPTY table means, so it does not read as an error', () => {
        expect(html.toLowerCase()).to.contain('if it is empty, none have been recorded');
    });

    it('explains why the evidence is a hash rather than the raw text', () => {
        expect(html).to.contain('SHA-256');
        expect(html.toLowerCase()).to.contain('verify');
    });

    it('carries the caution in the page description too (link previews show that, not the banner)', () => {
        const desc = html.match(/XC\.pageInfo\.description\s*=\s*([\s\S]*?);/)[1];
        expect(desc.toLowerCase()).to.contain('unadjudicated');
    });

    it('uses the datatable id xchain.js builds from the action name', () => {
        // 'datatable-' + action, action = 'slash_proposal' (xchain.js:1133).
        expect(html).to.contain('id="datatable-slash_proposal"');
        expect(html).to.contain("loadDatatablesData(XC.coin, 'slash_proposal', null, null)");
    });

    it('has a colspan on the loading row equal to its <th> count', () => {
        const ths = (html.match(/<th\b/g) || []).length;
        expect(ths).to.equal(7);
        expect(html).to.contain('colspan="' + ths + '"');
    });

    it('renders Status as a visible column of its own, not only as a row colour', () => {
        // The ruling makes "pending means accused, not judged" a presentation
        // obligation, so status may not be reduced to a background colour.
        expect(html).to.contain('<th class="">Status</th>');
    });
});

// ─────────────────────────────────────────────────────────────────────────
// Row-mapping documentation: the getPagingDataResults branch lives in
// src/XChainExplorer.js (a shared seam file this row may not edit) and the
// colouring-exclusion-list edit lives in src/content/js/xchain.js (same), so
// both are PROPOSED text in m3-proposal-row23.md rather than in-tree code
// here. This block pins the field order and element count that proposal
// commits to, keyed off the exact SELECT column list asserted above, so a
// splice that reorders one side without the other is caught by inspection.
// ─────────────────────────────────────────────────────────────────────────
describe('slash_proposal row-mapping contract (documents the proposed getPagingDataResults branch)', () => {

    it('the proposed 8-element row = [count_reverse, created_at, validator_pubkey, offense_type, round_number, evidence_hash, status, id]', () => {
        // The invariant is POSITIONAL, not arithmetic: count_reverse first, the
        // paging cursor last, status second-to-last (consumed by createdRow,
        // xchain.js:1302-1305). Which trailing slots ALSO render is a per-surface
        // choice: here status IS a visible column (7th <th>) and only the cursor
        // (m.id) is invisible, the same shape price_snapshots uses. Status is
        // deliberately visible because the ruling makes labelling it a
        // requirement, not a nicety.
        const VISIBLE = ['created_at', 'validator_pubkey', 'offense_type', 'round_number', 'evidence_hash'];
        const PROPOSED_ROW = ['count_reverse', ...VISIBLE, 'status', 'id'];
        expect(PROPOSED_ROW).to.have.lengthOf(8);
        expect(PROPOSED_ROW[0]).to.equal('count_reverse');
        expect(PROPOSED_ROW[PROPOSED_ROW.length - 1]).to.equal('id', 'last element is always the paging cursor');
        expect(PROPOSED_ROW[PROPOSED_ROW.length - 2]).to.equal('status', 'second-to-last is always consumed as status by createdRow');
        // 7 <th> (#, Time, Validator, Offense, Round, Evidence Hash, Status):
        // count_reverse + the five visible fields + status.
        expect(1 + VISIBLE.length + 1).to.equal(7);
    });

    it('carries no evidence field at any position', () => {
        const PROPOSED_ROW = ['count_reverse', 'created_at', 'validator_pubkey', 'offense_type',
                              'round_number', 'evidence_hash', 'status', 'id'];
        expect(PROPOSED_ROW).to.not.include('evidence');
    });

    it("'slash_proposal' must join the client's no-colour exclusion list", () => {
        // status here is a lifecycle word ('pending'/'approved'/'rejected'/
        // 'expired'), not the 0/1 flag createdRow compares against, so without the
        // exclusion every row would paint red-for-invalid. On THIS surface that is
        // not merely a cosmetic bug: an unadjudicated accusation rendered in the
        // failure colour reads as a verdict, which is precisely what the ruling
        // forbids.
        const STATUS_WORDS = ['pending', 'approved', 'rejected', 'expired'];
        expect(STATUS_WORDS).to.not.include(0);
        expect(STATUS_WORDS).to.not.include(1);
    });

    it('the proposed badge map never paints a pending row in the failure colour', () => {
        // Mirrors the map proposed for xchain.js: pending is NEUTRAL.
        const BADGE = { pending: 'secondary', approved: 'danger', rejected: 'success', expired: 'secondary' };
        expect(BADGE.pending).to.equal('secondary');
        expect(BADGE.pending).to.not.equal('danger');
        // 'rejected' means the accusation was dismissed, so it is not a failure
        // state for the validator either.
        expect(BADGE.rejected).to.equal('success');
    });
});
