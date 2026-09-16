/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 */

'use strict';

const { expect, panelHtml, voteDetail } = require('../../content_client_renderer_action_parity.test.js');

describe('client: the VOTE poll panel shows the callback timelock and the EXECUTE it fired', function () {

    const POLL = {
        vote_kind: 'poll', action_index: 900, tick: 'XCP', question: 'ship it?',
        options: ['no', 'yes'], tally_mode: 'weighted', weight_mode: 'balance',
        max_selections: 1, end_block: 900000, quorum: 10, min_voters: 2,
        poll_status: 'finalized', winning_option: 1, deposit_amount: 5,
        callback_contract_index: 77, callback_method: 'onDecided'
    };

    it('links callback_execute_action_index as an action, the way ATTEST does', function () {
        const cell = voteDetail({ ...POLL, callback_delay_blocks: 144, callback_execute_action_index: 4242 });
        expect(cell.href('vote-callback-execute')).to.equal('/BTC/action/4242');
        expect(cell.text('vote-callback-execute')).to.equal('4242');
    });

    it('renders the PC-42 timelock the query has always selected', function () {
        const cell = voteDetail({ ...POLL, callback_delay_blocks: 144, callback_execute_action_index: 4242 });
        expect(cell.text('vote-callback-delay')).to.equal('144');
    });

    it('dashes both cells on a binding poll whose callback has not fired', function () {
        const cell = voteDetail({ ...POLL, callback_delay_blocks: 0, callback_execute_action_index: null });
        expect(cell.text('vote-callback-execute')).to.equal('-');
        expect(cell.text('vote-callback-delay')).to.equal('0');
    });

    it('dashes both cells on a non-binding poll', function () {
        const cell = voteDetail({
            ...POLL, callback_contract_index: null, callback_method: null,
            callback_delay_blocks: null, callback_execute_action_index: null
        });
        expect(cell.text('vote-callback')).to.equal('-');
        expect(cell.text('vote-callback-delay')).to.equal('-');
        expect(cell.text('vote-callback-execute')).to.equal('-');
    });

    it('[REGRESSION] the contract/method callback cell still renders beside them', function () {
        const cell = voteDetail({ ...POLL, callback_delay_blocks: 144, callback_execute_action_index: 4242 });
        expect(cell.href('vote-callback')).to.equal('/BTC/contract/77');
        expect(cell.text('vote-callback')).to.equal('77.onDecided');
    });

    it('every cell the poll branch writes exists in the shipped markup', function () {
        // The gap this covers was a renderer/template split: the JS read fields the
        // page had no cell for. Assert the pairing rather than the two halves.
        const panel = panelHtml('info-vote', 'info-bet');
        for (const cls of ['vote-callback', 'vote-callback-delay', 'vote-callback-execute'])
            expect(panel, cls + ' is missing from action.html').to.contain('class="' + cls + '"');
    });
});

// The finalization set is the third sighting of the same renderer/template split in
// this one function (response_payload, then the PC-42 callback pair). VOTE v2 freezes
// the measured turnout into the polls row so a terminal outcome stays auditable, and
// the detail query has always selected it, but a poll badged 'failed_quorum' named no
// gate and showed no turnout because nothing rendered it.
const POLL = {
    vote_kind: 'poll', action_index: 900, tick: 'XCP', question: 'ship it?',
    options: ['no', 'yes'], tally_mode: 'weighted', weight_mode: 'balance',
    max_selections: 1, end_block: 900000, quorum: '0.2', min_voters: 2,
    poll_status: 'failed_quorum', winning_option: null, deposit_amount: 5
};

// A failed poll: the gates were measured and missed, and fail_reason names which.
const FAILED = {
    ...POLL, quorum_met: 0, min_voters_met: 1, fail_reason: 'quorum',
    decided_early: 0, total_weight: '1234.5', total_voters: 7,
    effective_close_block: 900000, resolved_block: 900001, finalized_action_index: 4242
};

describe('client: the VOTE poll panel shows the finalization detail v2 froze', function () {
    it('names which gate failed instead of only badging failed_quorum', function () {
        const cell = voteDetail(FAILED);
        expect(cell.text('vote-fail-reason')).to.equal('quorum');
        expect(cell.text('vote-quorum-met')).to.equal('no');
        expect(cell.text('vote-min-voters-met')).to.equal('yes');
    });

    it('shows the measured turnout the quorum verdict was judged against', function () {
        const cell = voteDetail(FAILED);
        expect(cell.text('vote-total-weight')).to.equal('1234.5');
        expect(cell.text('vote-total-voters')).to.equal('7');
    });

    it('links the measurement block, the resolution block and the finalizing action', function () {
        const cell = voteDetail(FAILED);
        expect(cell.href('vote-effective-close-block')).to.equal('/BTC/block/900000');
        expect(cell.href('vote-resolved-block')).to.equal('/BTC/block/900001');
        expect(cell.href('vote-finalized-by')).to.equal('/BTC/action/4242');
    });

    it('flags an early decide and shows the threshold that armed it', function () {
        const cell = voteDetail({ ...FAILED, decided_early: 1, decide_threshold: '0.6' });
        expect(cell.text('vote-decided-early')).to.equal('yes');
        expect(cell.text('vote-decide-threshold')).to.equal('0.6');
    });
});

describe('client: the VOTE poll panel shows the finalization detail v2 froze', function () {
    it('dashes every finalization cell on an open poll rather than reading them as no', function () {
        // Null is "not yet measured"; TINYINT 0 is a measured miss. Collapsing the two
        // would show an open poll as having failed both gates.
        const cell = voteDetail({ ...POLL, poll_status: 'open' });
        for (const cls of ['vote-quorum-met', 'vote-min-voters-met', 'vote-decided-early',
                           'vote-total-weight', 'vote-total-voters', 'vote-fail-reason',
                           'vote-effective-close-block', 'vote-resolved-block', 'vote-finalized-by'])
            expect(cell.text(cls), cls + ' should dash while the poll is open').to.equal('-');
    });

    it('dashes fail_reason on a poll that passed both gates', function () {
        const cell = voteDetail({
            ...FAILED, poll_status: 'finalized', winning_option: 1,
            quorum_met: 1, min_voters_met: 1, fail_reason: null
        });
        expect(cell.text('vote-fail-reason')).to.equal('-');
        expect(cell.text('vote-quorum-met')).to.equal('yes');
    });

    it('renders deposit_resolved as its enum, not as a boolean', function () {
        // polls.deposit_resolved is ENUM('refunded','forfeited'). A forfeited deposit
        // rendered through a yes/no formatter would read as a successful refund.
        const forfeited = voteDetail({ ...FAILED, deposit_resolved: 'forfeited', deposit_address: 'mAddr1' });
        expect(forfeited.text('vote-deposit-resolved')).to.equal('forfeited');
        expect(forfeited.href('vote-deposit-address')).to.equal('/BTC/address/mAddr1');
        const refunded = voteDetail({ ...FAILED, deposit_resolved: 'refunded' });
        expect(refunded.text('vote-deposit-resolved')).to.equal('refunded');
    });

    it('shows the rest of the binding-poll contract', function () {
        const cell = voteDetail({ ...FAILED, callback_on: 'always', gas_escrow: '0.001' });
        expect(cell.text('vote-callback-on')).to.equal('always');
        expect(cell.text('vote-gas-escrow')).to.equal('0.001');
    });

    it('renders developer-supplied callback_params as inert text', function () {
        // callback_params is on-chain JSON afterMain has already parsed, so it is
        // attacker-shaped input reaching a cell; it must never open an element. Had the
        // cell been written through .html(), the payload would have become an <img> and
        // this .text() read would come back missing it.
        const cell = voteDetail({ ...FAILED, callback_params: ['<img src=x onerror=alert(1)>', 2] });
        expect(cell.text('vote-callback-params')).to.equal('["<img src=x onerror=alert(1)>",2]');
    });

    it('every finalization cell the poll branch writes exists in the shipped markup', function () {
        const panel = panelHtml('info-vote', 'info-bet');
        for (const cls of ['vote-min-vote-balance', 'vote-decide-threshold', 'vote-quorum-met',
                           'vote-min-voters-met', 'vote-total-weight', 'vote-total-voters',
                           'vote-fail-reason', 'vote-decided-early', 'vote-effective-close-block',
                           'vote-resolved-block', 'vote-finalized-by', 'vote-deposit-address',
                           'vote-deposit-resolved', 'vote-callback-on', 'vote-callback-params',
                           'vote-gas-escrow'])
            expect(panel, cls + ' is missing from action.html').to.contain('class="' + cls + '"');
    });
});
