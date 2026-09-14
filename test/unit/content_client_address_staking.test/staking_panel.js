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
 **********************************************************************/

'use strict';

const {
    ADDRESS, PAGE_HTML, DRIFT, MATURED, MIXED, NOTHING, SLASHED, VENUE,
    addressPage, cardShown, expect, makeWindow, page, stakingCardIsAboveTabs
} = require('../content_client_address_staking.test.js');

/* ------------------------------------------------------------------- tests */

describe('address.html staking panel @regression', function () {

    describe('placement and transport', function () {

        it('composes ABOVE the raw tab block it summarises', function () {
            expect(stakingCardIsAboveTabs()).to.equal(true);
        });

        it('fetches the composed staking route directly, not a datatable endpoint', async function () {
            const w = await page('success', VENUE);
            expect(w.__requestedUrl).to.equal('/RBTC/api/staking/' + ADDRESS);
        });

        it('accepts the {total,data} envelope as well as a bare object', async function () {
            const bare = await page('success', VENUE);
            const wrap = await page('success', { total: 1, data: [VENUE] });
            expect(cardShown(bare)).to.equal(true);
            expect(cardShown(wrap)).to.equal(true);
            expect(wrap.$('.addr-staking-cooldown-row').length).to.equal(1);
        });
    });

});

describe('address.html staking panel @regression', function () {

    describe('cooldown countdown: blocks against chain_tip, never wall clock', function () {

        it('renders the live venue cooldown as PENDING with 50 blocks remaining', async function () {
            const w = await page('success', VENUE);
            const row = w.$('.addr-staking-cooldown-row');
            expect(row.length).to.equal(1);
            expect(row.attr('data-cooldown-state')).to.equal('pending');
            // 2770 - 2720 = 50, derived from the response, not read off a label.
            expect(row.find('.addr-staking-remaining').text()).to.contain('50');
            expect(w.$('.addr-staking-countdown').attr('data-cooldown-state')).to.equal('pending');
            expect(w.$('.addr-staking-countdown').text()).to.contain('50');
            expect(w.$('.addr-staking-tip').text()).to.contain('2,720');
        });

        it('treats tip === cooldown_end_block as MATURED (the release rule is tip >= end)', async function () {
            const w = await page('success', MATURED);
            const row = w.$('.addr-staking-cooldown-row');
            expect(row.attr('data-cooldown-state')).to.equal('matured');
            expect(w.$('.addr-staking-countdown').attr('data-cooldown-state')).to.equal('matured');
        });

        it('separates a matured and a pending cooldown inside one table', async function () {
            const w = await page('success', MIXED);
            const states = w.$('.addr-staking-cooldown-row').map(function (i, el) {
                return w.$(el).attr('data-cooldown-state');
            }).get();
            expect(states).to.deep.equal(['matured', 'pending']);
            // The soonest OUTSTANDING release heads the summary: 2930 - 2800.
            expect(w.$('.addr-staking-countdown').attr('data-cooldown-state')).to.equal('pending');
            expect(w.$('.addr-staking-countdown').text()).to.contain('130');
        });

        it('derives maturity itself rather than trusting the row flags', async function () {
            const w = makeWindow();
            // Server-precomputed fields deliberately CONTRADICT the heights here.
            const s = w.addrStakingCooldownState(
                { cooldown_end_block: 2770, blocks_remaining: 0, matured: true }, 2720);
            expect(s.key).to.equal('pending');
            expect(s.blocks_remaining).to.equal(50);
        });

        it('a cooldown with no end height is UNKNOWN, never matured', function () {
            const w = makeWindow();
            expect(w.addrStakingCooldownState({ cooldown_end_block: null }, 2720).key).to.equal('unknown');
            expect(w.addrStakingCooldownState({ cooldown_end_block: 2770 }, null).key).to.equal('unknown');
        });
    });

});

describe('address.html staking panel @regression', function () {

    describe('both slash families, never merged', function () {

        it('renders two separately counted families with their own columns', async function () {
            const w = await page('success', SLASHED);
            const families = w.$('.addr-staking-slash-family');
            expect(families.length).to.equal(2);
            const keys = families.map(function (i, el) { return w.$(el).attr('data-family'); }).get();
            expect(keys).to.deep.equal(['capability', 'contract']);
            // One row each, and each row lives under its OWN family.
            expect(w.$('.addr-staking-slash-family[data-family="capability"] .addr-staking-slash-row').length).to.equal(1);
            expect(w.$('.addr-staking-slash-family[data-family="contract"] .addr-staking-slash-row').length).to.equal(1);
            const counts = w.$('.addr-staking-slash-count').map(function (i, el) {
                return w.$(el).text().trim();
            }).get();
            expect(counts).to.deep.equal(['1', '1']);
        });

        it('keeps a capability slash out of the contract family entirely', async function () {
            const w = await page('success', SLASHED);
            // The equivocation key is a capability-only column; finding it in the
            // contract family would mean the two lists had been folded together.
            const contract = w.$('.addr-staking-slash-family[data-family="contract"]').html();
            expect(contract).to.not.contain('aa'.repeat(10));
            const capability = w.$('.addr-staking-slash-family[data-family="capability"]').html();
            expect(capability).to.contain('aa'.repeat(10));
        });

        it('counts one family as zero without borrowing the other family rows', async function () {
            const w = await page('success', VENUE);
            expect(w.$('.addr-staking-slash-family[data-family="capability"] .addr-staking-slash-row').length).to.equal(0);
            expect(w.$('.addr-staking-slash-family[data-family="contract"] .addr-staking-slash-row').length).to.equal(1);
            expect(w.$('.addr-staking-slash-total').text().trim()).to.equal('1');
        });
    });

});

describe('address.html staking panel @regression', function () {

    describe('BTC-only sections are empty BY PROTOCOL on other chains', function () {

        it('on DOGE, collects / rewards / capability slashing say BTC-only, not "none"', async function () {
            const w = await page('success', VENUE, 'DOGE', 'DOGE');
            const empties = {};
            w.$('.addr-staking-section[data-section="collects"] .addr-staking-empty,'
              + '.addr-staking-section[data-section="rewards"] .addr-staking-empty').each(function (i, el) {
                empties[w.$(el).closest('.addr-staking-section').attr('data-section')] = w.$(el).attr('data-empty');
            });
            expect(empties.collects).to.equal('btc-only');
            expect(empties.rewards).to.equal('btc-only');
            expect(w.$('.addr-staking-slash-family[data-family="capability"] .addr-staking-empty')
                    .attr('data-empty')).to.equal('btc-only');
            expect(w.$('.addr-staking-section[data-section="cooldown-capability"] .addr-staking-empty')
                    .attr('data-empty')).to.equal('btc-only');
            expect(w.$('.addr-staking-section[data-section="positions-capability"] .addr-staking-empty')
                    .attr('data-empty')).to.equal('btc-only');
        });

        it('never dresses the BTC-only empty state as a fault', async function () {
            const w = await page('success', VENUE, 'DOGE', 'DOGE');
            const notes = w.$('.addr-staking-empty[data-empty="btc-only"]');
            expect(notes.length).to.be.at.least(3);
            notes.each(function (i, el) {
                const cls = w.$(el).attr('class');
                expect(cls).to.not.contain('alert');
                expect(cls).to.not.contain('text-danger');
                expect(cls).to.not.contain('text-warning');
            });
        });

        it('a contract-stake section on DOGE is NOT labelled BTC-only', async function () {
            const w = await page('success', { ...VENUE, cooldowns: [] }, 'DOGE', 'DOGE');
            expect(w.$('.addr-staking-section[data-section="cooldown-contract"] .addr-staking-empty')
                    .attr('data-empty')).to.equal('none');
        });

        it('on BTC the SAME empty arrays read as "none", because they still could fill', async function () {
            const w = await page('success', VENUE, 'BTC', 'BTC');
            expect(w.$('.addr-staking-section[data-section="collects"] .addr-staking-empty')
                    .attr('data-empty')).to.equal('none');
            expect(w.$('.addr-staking-section[data-section="rewards"] .addr-staking-empty')
                    .attr('data-empty')).to.equal('none');
            expect(w.$('.addr-staking-slash-family[data-family="capability"] .addr-staking-empty')
                    .attr('data-empty')).to.equal('none');
        });

        it('regtest RBTC and testnet TBTC are the BTC chain family, not other chains', async function () {
            for (const coin of ['RBTC', 'TBTC', 'BTC']) {
                const w = await page('success', VENUE, coin, 'BTC');
                expect(w.$('.addr-staking-section[data-section="collects"] .addr-staking-empty')
                        .attr('data-empty'), coin).to.equal('none');
            }
        });
    });

});

describe('address.html staking panel @regression', function () {

    describe('claimable is unclamped: a negative value is drift, not a balance', function () {

        it('renders negative claimable as drift, with an explicit fault note', async function () {
            const w = await page('success', DRIFT);
            expect(cardShown(w)).to.equal(true);
            expect(w.$('.addr-staking-claimable').attr('data-claimable')).to.equal('drift');
            expect(w.$('.addr-staking-claimable-detail').attr('data-claimable')).to.equal('drift');
            expect(w.$('.addr-staking-drift-alert').length).to.equal(1);
            expect(w.$('.addr-staking-claimable').text()).to.contain('-2.50000000');
        });

        it('does not print drift in the same chrome a real balance uses', async function () {
            const drifted = await page('success', DRIFT);
            const normal  = await page('success', { ...DRIFT, claimable: '2.50000000', collected_total: '7.50000000' });
            expect(normal.$('.addr-staking-claimable').attr('data-claimable')).to.equal('positive');
            expect(normal.$('.addr-staking-drift-alert').length).to.equal(0);
            expect(drifted.$('.addr-staking-claimable').attr('class'))
                .to.not.equal(normal.$('.addr-staking-claimable').attr('class'));
        });

        it('zero claimable is neither drift nor a claim', async function () {
            const w = await page('success', VENUE);
            expect(w.$('.addr-staking-claimable').attr('data-claimable')).to.equal('zero');
            expect(w.$('.addr-staking-drift-alert').length).to.equal(0);
        });
    });

});

describe('address.html staking panel @regression', function () {

    describe('containment: the rest of address.html is never harmed', function () {

        it('hides the card for an address with no staking activity at all', async function () {
            const w = await page('success', NOTHING);
            expect(w.addrStakingHasActivity(NOTHING)).to.equal(false);
            expect(cardShown(w)).to.equal(false);
            // Hidden, NOT broken: no error text is planted anywhere in the card.
            expect(w.$('#addr-staking-summary').html()).to.equal('');
            expect(w.$('#addr-staking-cooldowns').html()).to.equal('');
            // and the page's own panels are untouched
            expect(w.$('#data-panels').length).to.equal(1);
            expect(w.$('#address-proof-balance-btn').length).to.equal(1);
        });

        it('shows the card when drift is the ONLY thing on the address', function () {
            const w = makeWindow();
            expect(w.addrStakingHasActivity(DRIFT)).to.equal(true);
        });

        it('survives a failed staking fetch with the rest of the page intact', async function () {
            const w = await page('fail', { status: 500, responseJSON: { error: 'boom' } });
            expect(cardShown(w)).to.equal(false);
            expect(w.$('#data-panels').length).to.equal(1);
            expect(w.$('#datatable-balance').length).to.equal(1);
            expect(w.$('#address-proof-balance-btn').length).to.equal(1);
            expect(w.$('.table-address-stats').length).to.equal(2);
            expect(w.document.body.innerHTML).to.not.contain('boom');
        });

        it('keeps its element ids namespaced so they cannot collide with the page', function () {
            const ids = [...PAGE_HTML.matchAll(/id="(addr-staking[^"]*)"/g)].map(m => m[1]);
            expect(ids.length).to.be.at.least(6);
            for (const id of ids) expect(id).to.match(/^addr-staking-/);
        });
    });

});

/* XC.query is null on any /{COIN}/address/{X} whose segment did not read as an
     * address for this coin (setXChainParams only assigns it behind isCryptoAddress).
     * The page then asked for three things that do not exist: the BARE collection
     * route /{COIN}/api/address (loadApiData drops a falsy query from the path
     * entirely, so the required id segment simply went missing), the staking record
     * of an address named "null", and an SPV proof for that same "null" address,
 * because encodeURIComponent(null) is the STRING "null". */
describe('address.html staking panel @regression', function () {
    describe('an absent address never becomes a path segment', function () {
        [['null', null], ['empty string', '']].forEach(function (pair) {

            it('[no-id] XC.query ' + pair[0] + ' issues NO staking request', async function () {
                const w = await page('success', VENUE, 'RBTC', 'BTC', pair[1]);
                expect(w.__requestedUrls).to.deep.equal([]);
                // Hidden, exactly as a no-activity address is, and not broken.
                expect(cardShown(w)).to.equal(false);
                expect(w.$('#data-panels').length).to.equal(1);
            });

            it('[no-id] XC.query ' + pair[0] + ' issues NO address request, bare route included', function () {
                const p = addressPage(pair[1]);
                expect(p.seen, 'no address request may be issued without an id').to.deep.equal([]);
                // The specific shape the old code produced: the id segment dropped
                // and the collection route requested in its place.
                expect(p.seen).to.not.include('/RBTC/api/address');
                expect(p.w.$('#address-missing-id').length).to.equal(1);
                // and the placeholder zero is gone rather than left reading as data
                expect(p.w.$('#address').text()).to.not.equal('0');
            });

            it('[no-id] XC.query ' + pair[0] + ' proves no balance for an address named "null"', function () {
                const p = addressPage(pair[1]);
                expect(p.proofUrls).to.deep.equal([]);
                // Both widgets say why, rather than sitting silent.
                expect(p.w.$('#address-proof-balance-result .proof-notice').attr('data-level')).to.equal('warning');
                expect(p.w.$('#address-proof-locked-result .proof-notice').attr('data-level')).to.equal('warning');
            });
        });

        it('[has-id] a real address still reaches all three routes with its id in the path', function () {
            const p = addressPage();
            expect(p.seen).to.deep.equal(['/RBTC/api/address/' + ADDRESS]);
            expect(p.proofUrls).to.deep.equal([
                '/RBTC/api/proof/balance/' + ADDRESS + '/XCHAIN',
                '/RBTC/api/proof/locked-balance/' + ADDRESS + '/XCHAIN'
            ]);
            expect(p.w.$('#address-missing-id').length).to.equal(0);
        });

        it('[has-id] the staking route is unchanged for a real address', async function () {
            const w = await page('success', VENUE);
            expect(w.__requestedUrls).to.deep.equal(['/RBTC/api/staking/' + ADDRESS]);
        });

        it('[hostile-id] a path-bearing address is escaped into ONE segment on every route', async function () {
            const hostile = '../../admin';
            const w = await page('success', VENUE, 'RBTC', 'BTC', hostile);
            expect(w.__requestedUrls).to.deep.equal(['/RBTC/api/staking/..%2F..%2Fadmin']);
            const p = addressPage(hostile);
            expect(p.proofUrls).to.deep.equal([
                '/RBTC/api/proof/balance/..%2F..%2Fadmin/XCHAIN',
                '/RBTC/api/proof/locked-balance/..%2F..%2Fadmin/XCHAIN'
            ]);
        });
    });

});

describe('address.html staking panel @regression', function () {

    describe('positions', function () {

        it('renders both venue positions and marks the closed one', async function () {
            const w = await page('success', VENUE);
            const rows = w.$('.addr-staking-position-row[data-family="contract"]');
            expect(rows.length).to.equal(2);
            const states = rows.map(function (i, el) { return w.$(el).attr('data-position-state'); }).get();
            expect(states).to.deep.equal(['active', 'ended']);
            expect(w.$('.addr-staking-position-total').text().trim()).to.equal('2');
        });
    });
});
