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
 * Address staking panel (address.html + js/address-staking-render.js),
 * fed by /{COIN}/api/staking/{QUERY} (getAddressStaking, src/db.js).
 *
 * Drives the SHIPPED derivation, the SHIPPED render and the SHIPPED inline
 * loader in address.html with stubbed responses, in the same JSDOM-eval
 * harness content-client-validator-detail.test.js uses.
 *
 * What it protects:
 *
 *  - THE COOLDOWN COUNTDOWN IS IN BLOCKS, against the chain_tip served in the
 *    same response. `cooldown_end_block` alone is a bare height and answers
 *    nothing; the release rule is `tip >= cooldown_end_block`, so the block
 *    that EQUALS the end height has already released. Matured and pending are
 *    asserted as two different rendered states, not as one row with a
 *    different number in it.
 *
 *  - THE TWO SLASH FAMILIES STAY APART. capability_slash_events (consensus
 *    equivocation) and slash_events (contract EXECUTE burn) carry different
 *    columns and different meanings; a merged list has a count true of
 *    neither, so separation is asserted structurally.
 *
 *  - THE BTC-ONLY EMPTY STATE IS NOT "NONE YET". COLLECT, capability staking
 *    and capability slashing are rejected outright on any non-BTC chain by the
 *    indexer (actions/collect.js, actions/stake.js, actions/slash.js), so those
 *    arrays are empty BY PROTOCOL on DOGE and LTC. "No rewards yet" would tell
 *    a DOGE holder something false about their own address. The two empty
 *    states are therefore distinct rendered branches, keyed on the CHAIN.
 *
 *  - UNCLAMPED CLAIMABLE. A negative remainder is ledger drift and must render
 *    as a fault, never as a balance.
 *
 *  - CONTAINMENT. An address with no staking activity, and a failed staking
 *    fetch, both leave the rest of address.html intact.
 *
 * Run: npx mocha test/unit/content-client-address-staking.test.js
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { expect } = require('chai');

const SRC_DIR     = path.resolve(__dirname, '../../src/content');
const XCHAIN_SRC  = fs.readFileSync(path.join(SRC_DIR, 'js/xchain.js'), 'utf8');
const RENDER_SRC  = fs.readFileSync(path.join(SRC_DIR, 'js/address-staking-render.js'), 'utf8');
const PAGE_HTML   = fs.readFileSync(path.join(SRC_DIR, 'html/address.html'), 'utf8');
const JQUERY_SRC  = fs.readFileSync(path.join(SRC_DIR, 'js/jquery.min.js'), 'utf8');
const NUMERAL_SRC = fs.readFileSync(path.join(SRC_DIR, 'js/numeral.js'), 'utf8');

function extractFn(src, name) {
    const sig = 'function ' + name + '(';
    const start = src.indexOf(sig);
    if (start < 0) throw new Error('function not found: ' + name);
    const braceStart = src.indexOf('{', start);
    let depth = 0, i = braceStart;
    for (; i < src.length; i++) {
        const c = src[i];
        if (c === '{') depth++;
        else if (c === '}') { depth--; if (depth === 0) { i++; break; } }
    }
    return src.slice(start, i);
}

// address.html carries MORE than one inline script (the pre-existing loader for
// the address stats and the SPV proof widgets, plus the staking loader added
// with this panel). The staking one is selected by its own content rather than
// by position, so re-ordering the page cannot silently make this suite drive
// the wrong block.
function stakingInlineScript() {
    const blocks = [...PAGE_HTML.matchAll(/<script type="text\/javascript">([\s\S]*?)<\/script>/g)]
        .map(m => m[1])
        .filter(b => b.includes('addr-staking-card'));
    if (blocks.length !== 1)
        throw new Error('expected exactly one staking inline script in address.html, found ' + blocks.length);
    return blocks[0];
}

// The staking panel's markup must sit ABOVE the raw tab block it composes.
function stakingCardIsAboveTabs() {
    return PAGE_HTML.indexOf('id="addr-staking-card"') < PAGE_HTML.indexOf('id="data-panels"');
}

function pageMarkup() {
    return PAGE_HTML.replace(/<script[\s\S]*?<\/script>/g, '');
}

const ADDRESS = 'moJERw6emt4gjdFKc3RPHMzY3zWtT468Ct';
const PUBKEY  = 'ed'.repeat(32);

function makeWindow(coin, chain) {
    const dom = new JSDOM('<!DOCTYPE html><body>' + pageMarkup() + '</body>', { runScripts: 'outside-only' });
    dom.window.eval(JQUERY_SRC);
    dom.window.eval(NUMERAL_SRC);
    dom.window.eval(extractFn(XCHAIN_SRC, 'isNull'));
    dom.window.eval(extractFn(XCHAIN_SRC, 'escapeHtml'));
    dom.window.eval(extractFn(XCHAIN_SRC, 'formatAmount'));
    dom.window.eval(extractFn(XCHAIN_SRC, 'formatHash'));
    dom.window.eval(extractFn(XCHAIN_SRC, 'formatLivestamp'));
    dom.window.eval(`
        function formatLink(href, text){ return '<a href="' + href + '">' + text + '</a>'; }
    `);
    dom.window.XC = {
        coin:  coin  || 'RBTC',
        chain: chain || 'BTC',
        name: 'Bitcoin', network: 'regtest', query: ADDRESS, pageInfo: {}
    };
    dom.window.eval(RENDER_SRC);
    return dom.window;
}

// JSDOM has no layout, so jQuery's :visible is false for EVERY element and
// would pass a "hidden" assertion no matter what the page did. The card's
// visibility is read off its display instead, which is what .show()/.hide()
// actually change.
function cardShown(w) {
    return w.$('#addr-staking-card').css('display') !== 'none';
}

// Drives the shipped inline loader with a stubbed $.getJSON, exactly as the
// browser runs it, and returns the populated window.
function page(mode, payload, coin, chain) {
    const w = makeWindow(coin, chain);
    w.$.getJSON = function (url, cb) {
        w.__requestedUrl = url;
        if (mode === 'success') cb(payload);
        const handle = { fail: function (f) { if (mode === 'fail') f(payload); return handle; } };
        return handle;
    };
    w.eval(stakingInlineScript());
    return new Promise(resolve => setTimeout(() => resolve(w), 0));
}

/* ---------------------------------------------------------------- fixtures */
/* Column names below are taken from getAddressStaking (src/db.js) and its
 * _collectTrail helper; nothing here is invented. */

// The live regtest venue, as driven against address moJERw6emt4gjdFKc3RPHMzY3zWtT468Ct:
// tip 2720, two contract positions, ONE pending cooldown maturing at 2770
// (50 blocks out), no capability positions, no collects, no rewards, one
// contract slash event and no capability slash events.
const VENUE = {
    address: ADDRESS,
    chain_tip: 2720,
    positions: [
        { action_index: 1044, version: 1, signing_pubkey: PUBKEY, target_contract_index: 12, tick: 'XCHAIN',
          amount: '500.00000000', activation_block: 2600, deactivation_block: null, block_index: 2590,
          timestamp: 1750000000, status: 'valid' },
        { action_index: 1040, version: 1, signing_pubkey: PUBKEY, target_contract_index: 12, tick: 'XCHAIN',
          amount: '200.00000000', activation_block: 2500, deactivation_block: 2700, block_index: 2490,
          timestamp: 1749000000, status: 'valid' }
    ],
    capability_positions: [],
    cooldowns: [
        { action_index: 1046, signing_pubkey: PUBKEY, target_contract_index: 12, tick: 'XCHAIN',
          amount: '200', cooldown_end_block: 2770, block_index: 2700, timestamp: 1750100000, status: 'valid',
          blocks_remaining: 50, matured: false }
    ],
    capability_cooldowns: [],
    rewards: [],
    rewards_total:   '0.00000000',
    collected_total: '0.00000000',
    claimable:       '0.00000000',
    collects: [],
    capability_slash_events: [],
    slash_events: [
        { id: '41', execution_index: 1050, target_contract_index: 12, slashed_pubkey: PUBKEY, tick: 'XCHAIN',
          amount: '25.00000000', destination: 'bcrt1qburn', block_index: 2710, timestamp: 1750200000 }
    ]
};

// The same address one release later: the cooldown's end height has been
// reached exactly (tip === cooldown_end_block), which the consensus rule
// `tip >= end` already treats as released.
const MATURED = {
    ...VENUE,
    chain_tip: 2770,
    cooldowns: [{ ...VENUE.cooldowns[0], blocks_remaining: 0, matured: true }]
};

// Two cooldowns, one on each side of the tip, so the render has to tell them
// apart within a single table.
const MIXED = {
    ...VENUE,
    chain_tip: 2800,
    cooldowns: [
        { action_index: 1046, signing_pubkey: PUBKEY, target_contract_index: 12, tick: 'XCHAIN',
          amount: '200', cooldown_end_block: 2770, block_index: 2700, timestamp: 1750100000, status: 'valid' },
        { action_index: 1047, signing_pubkey: PUBKEY, target_contract_index: 12, tick: 'XCHAIN',
          amount: '300', cooldown_end_block: 2930, block_index: 2790, timestamp: 1750300000, status: 'valid' }
    ]
};

// An address that has never touched staking: every array empty, every total 0.
const NOTHING = {
    address: ADDRESS,
    chain_tip: 2720,
    positions: [], capability_positions: [], cooldowns: [], capability_cooldowns: [],
    rewards: [], rewards_total: '0.00000000', collected_total: '0.00000000',
    claimable: '0.00000000', collects: [],
    capability_slash_events: [], slash_events: []
};

// Ledger drift: more COLLECTed than ever accrued. The server does NOT clamp.
const DRIFT = {
    ...NOTHING,
    rewards_total:   '10.00000000',
    collected_total: '12.50000000',
    claimable:       '-2.50000000',
    collects: [
        { action_index: 1090, amount: '12.50000000', block_index: 2680, timestamp: 1750050000, status: 'valid' }
    ]
};

// Both slash families populated, each with the columns its own query selects.
const SLASHED = {
    ...VENUE,
    capability_slash_events: [
        { id: '31', slash_action_index: 1500, slashed_pubkey: PUBKEY, capability: 'oracle_publish',
          equiv_key: 'aa'.repeat(32), amount: '100.00000000', bounty_amount: '10.00000000',
          treasury_amount: '90.00000000', block_index: 2715, timestamp: 1750210000 }
    ]
};

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
