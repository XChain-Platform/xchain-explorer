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
 * Address staking panel (address.html + js/address_staking_render.js),
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

const { srcText } = require('../../../helpers/source_text');

const fs   = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { expect } = require('chai');

const SRC_DIR     = path.resolve(__dirname, '..', '..', '../../src/content');
// formatters.js is read alongside xchain.js because the cell-rendering helpers
// (isNull, escapeHtml, formatAmount, formatHash, formatLivestamp) moved there
// in the component milestone. Concatenated rather than switched, so this file
// keeps naming ONE source for every helper it lifts and does not have to know
// which of the two a given function ended up in.
const XCHAIN_SRC  = srcText('src/content/js/xchain.js')
    + '\n' + fs.readFileSync(path.join(SRC_DIR, 'js/formatters.js'), 'utf8');
const RENDER_SRC  = srcText('src/content/js/address_staking_render.js');
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

function makeWindow(coin, chain, query) {
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
        name: 'Bitcoin', network: 'regtest',
        // Compared against undefined, not truthiness, so a caller can plant the
        // ABSENT ids (null, '') setXChainParams leaves behind on a path segment it
        // could not read as an address for this coin.
        query: query === undefined ? ADDRESS : query,
        pageInfo: {}
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
function page(mode, payload, coin, chain, query) {
    const w = makeWindow(coin, chain, query);
    w.__requestedUrls = [];
    w.$.getJSON = function (url, cb) {
        w.__requestedUrl = url;
        w.__requestedUrls.push(url);
        if (mode === 'success') cb(payload);
        const handle = { fail: function (f) { if (mode === 'fail') f(payload); return handle; } };
        return handle;
    };
    w.eval(stakingInlineScript());
    return new Promise(resolve => setTimeout(() => resolve(w), 0));
}

/* ------------------------------------------------------------------------- *
 * The address page's OTHER inline block: the header fetch and the two SPV
 * proof widgets. It is driven here rather than in a file of its own because
 * the id guard it shares with the staking loader is one behaviour, and pinning
 * the two halves apart is how they drift.
 * ------------------------------------------------------------------------- */
function addressInlineScript() {
    const blocks = [...PAGE_HTML.matchAll(/<script type="text\/javascript">([\s\S]*?)<\/script>/g)]
        .map(m => m[1])
        .filter(b => b.includes("loadApiData(XC.coin, 'address'"));
    if (blocks.length !== 1)
        throw new Error('expected exactly one address-info inline script in address.html, found ' + blocks.length);
    return blocks[0];
}

// Runs that block with the REAL loadApiData out of xchain.js, so the URL the
// assertions read is the one the shipped code builds rather than a restatement
// of it, then clicks both proof buttons with a tick filled in.
function addressPage(query) {
    const w = makeWindow('RBTC', 'BTC', query);
    const seen = [];
    w.$.getJSON = function (url, cb) {
        seen.push(url);
        return { fail: function () { return this; } };
    };
    w.eval(extractFn(XCHAIN_SRC, 'isNumeric'));
    w.eval(`
        function updatePageInfo(){}
        function setupActionListeners(){}
        function loadDatatablesData(){}
        function renderControllerBindings(){}
        function proofNotice(level, msg){ return '<span class="proof-notice" data-level="' + level + '">' + msg + '</span>'; }
        function loadProofWidget(url){ window.__proofUrls.push(url); }
        jQuery.fn.qrcode = function(){ return this; };
        // Run the ready callback synchronously so the assertions do not race
        // jQuery's deferred ready queue. Harness-only; the page is untouched.
        jQuery.fn.ready = function(fn){ fn(jQuery); return this; };
    `);
    w.__proofUrls = [];
    w.eval(extractFn(XCHAIN_SRC, 'loadApiData'));
    w.eval(addressInlineScript());
    w.$('#address-proof-tick').val('XCHAIN');
    w.$('#address-proof-balance-btn').click();
    w.$('#address-proof-locked-btn').click();
    return { w: w, seen: seen, proofUrls: w.__proofUrls };
}

/* ---------------------------------------------------------------- fixtures */
/* Column names below are taken from getAddressStaking (src/db.js) and its
 * collectTrail helper; nothing here is invented. */

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

module.exports = {
    ADDRESS, PAGE_HTML, DRIFT, MATURED, MIXED, NOTHING, SLASHED, VENUE,
    addressPage, cardShown, expect, makeWindow, page, stakingCardIsAboveTabs
};

require('./content_client_address_staking.test/support/staking_panel.js');
