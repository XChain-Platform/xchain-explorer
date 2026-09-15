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
 * Validator detail page (/{COIN}/validator/{QUERY}).
 *
 * Drives the SHIPPED derivation + render (src/content/js/validator_detail_render.js)
 * and the SHIPPED inline loader in src/content/html/validator.html with stubbed
 * /api/validator responses, in the same JSDOM-eval harness
 * content-client-xcall-timeline.test.js uses.
 *
 * What it protects, all of it structurally undrivable on the regtest venue
 * (`validators` returns zero rows there, and no ATTEST round can run):
 *
 *  - The three-flag capability reading. qualified / self_test_ok / enabled are
 *    independent, and a NULL self_test_ok is a self-test that never reported,
 *    not one that failed. Three yes/no badges leave that distinction to the
 *    reader; these cases pin the combined state instead.
 *  - registry_known:false. An unreadable hub registry must render as UNKNOWN,
 *    never as "unregistered" and never as "qualified for nothing" - an outage
 *    drawn as an empty result is a false claim about consensus state.
 *  - The two slash families stay apart. capability_slash_events (consensus
 *    equivocation) and slash_events (contract EXECUTE burn) carry different
 *    columns and different meanings; a merged list has a count that is true of
 *    neither, so separation is asserted structurally, not by wording.
 *  - Unclamped claimable. A negative remainder is ledger drift and must be
 *    visible as such rather than printed as a balance.
 *  - The page's explicit not-found and transport-failure branches.
 */

'use strict';

const { srcText } = require('../../../helpers/source_text');

const fs   = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { expect } = require('chai');

const SRC_DIR     = path.resolve(__dirname, '../../../../src/content');
// formatters.js is read alongside xchain.js because the cell-rendering helpers
// (isNull, escapeHtml, formatAmount, formatHash, formatLivestamp) moved there
// in the component milestone. Concatenated rather than switched, so this file
// keeps naming ONE source for every helper it lifts and does not have to know
// which of the two a given function ended up in.
const XCHAIN_SRC  = srcText('src/content/js/xchain.js')
    + '\n' + fs.readFileSync(path.join(SRC_DIR, 'js/formatters.js'), 'utf8');
const RENDER_SRC  = srcText('src/content/js/validator_detail_render.js');
const PAGE_HTML   = fs.readFileSync(path.join(SRC_DIR, 'html/validator.html'), 'utf8');
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

// The page fragment's own inline loader (the LAST <script> block, the one with
// no src attribute), so the not-found and error branches run as shipped.
function inlineScript() {
    const open = PAGE_HTML.lastIndexOf('<script type="text/javascript">');
    if (open < 0) throw new Error('inline script block not found in validator.html');
    const bodyStart = PAGE_HTML.indexOf('>', open) + 1;
    const end = PAGE_HTML.indexOf('</script>', bodyStart);
    if (end < 0) throw new Error('unterminated inline script in validator.html');
    return PAGE_HTML.slice(bodyStart, end);
}

// The fragment's markup with its <script> tags removed; the scripts are eval'd
// by hand so the JSDOM never needs to fetch /js/*.
function pageMarkup() {
    return PAGE_HTML.replace(/<script[\s\S]*?<\/script>/g, '');
}

const PUBKEY = 'ed'.repeat(32);
const SOURCE = 'bcrt1qvalidatorsource';

function makeWindow() {
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
        function updatePageInfo(){}
    `);
    dom.window.XC = { coin: 'BTC', name: 'Bitcoin', network: 'mainnet', query: PUBKEY, pageInfo: {} };
    dom.window.eval(RENDER_SRC);
    return dom.window;
}

// Drives the shipped page loader with a stubbed $.getJSON, exactly as the
// browser runs it, and returns the populated jQuery.
function page(mode, payload) {
    const w = makeWindow();
    w.$.getJSON = function (url, cb) {
        w.__requestedUrl = url;
        if (mode === 'success') cb(payload);
        const handle = { fail: function (f) { if (mode === 'fail') f(payload); return handle; } };
        return handle;
    };
    // The fragment wraps its work in $(document).ready; the document is already
    // loaded here, so the callback runs on the next microtask.
    w.eval(inlineScript());
    return new Promise(resolve => setTimeout(() => resolve(w), 0));
}

// Field names taken from getValidator (src/db.js:11014) and its two helpers
// collectTrail / validatorCapabilityRows: nothing here is invented.
const BASE = {
    query: PUBKEY,
    signing_pubkey: PUBKEY,
    source: SOURCE,
    stake_action_index: 3001,
    version: 1,
    activation_block: 900010,
    deactivation_block: null,
    block_index: 900000,
    registry: { addr: 'https://validator.example', chains: 'BTC,LTC', status: 'active' },
    registry_known: true,
    active_stake: '1000.00000000',
    position_count: 2,
    capabilities: [
        { id: '11', signing_pubkey: PUBKEY, capability: 'oracle_publish', qualified: 1, self_test_ok: 1, enabled: 1, qualified_at_block: '900010', updated_at: 1750000000 },
        { id: '12', signing_pubkey: PUBKEY, capability: 'attest',         qualified: 1, self_test_ok: 0, enabled: 1, qualified_at_block: '900011', updated_at: 1750000100 },
        { id: '13', signing_pubkey: PUBKEY, capability: 'nodeproof',      qualified: 1, self_test_ok: null, enabled: 1, qualified_at_block: '900012', updated_at: 1750000200 },
        { id: '14', signing_pubkey: PUBKEY, capability: 'relay',          qualified: 1, self_test_ok: 1, enabled: 0, qualified_at_block: '900013', updated_at: 1750000300 },
        { id: '15', signing_pubkey: PUBKEY, capability: 'checkpoint',     qualified: 0, self_test_ok: 1, enabled: 1, qualified_at_block: null,     updated_at: 1750000400 }
    ],
    stakes: [
        { action_index: 3001, version: 1, amount: '600.00000000', activation_block: 900010, deactivation_block: null,   block_index: 900000, timestamp: 1750000000, status: 'valid' },
        { action_index: 2900, version: 1, amount: '400.00000000', activation_block: 899910, deactivation_block: null,   block_index: 899900, timestamp: 1749900000, status: 'valid' },
        { action_index: 2800, version: 0, amount: '100.00000000', activation_block: 899810, deactivation_block: 899900, block_index: 899800, timestamp: 1749800000, status: 'valid' },
        { action_index: 2700, version: 0, amount: '50.00000000',  activation_block: null,   deactivation_block: null,   block_index: 899700, timestamp: 1749700000, status: 'invalid: insufficient funds' }
    ],
    unstakes: [
        { action_index: 3100, amount: '25.00000000', cooldown_end_block: 901000, block_index: 900500, timestamp: 1750100000, status: 'valid' }
    ],
    delegations: [
        { action_index: 3200, source: SOURCE, activation_block: 900020, deactivation_block: null,   block_index: 900020, timestamp: 1750200000, status: 'valid' },
        { action_index: 3150, source: SOURCE, activation_block: 899950, deactivation_block: 900019, block_index: 899950, timestamp: 1749950000, status: 'valid' }
    ],
    revocations: [
        { action_index: 3199, source: SOURCE, deactivation_block: 900019, block_index: 900019, timestamp: 1750199000, status: 'valid' }
    ],
    rotations: [
        { id: '77', target_table: 'contract_delegations', delegation_action_index: 3200, stake_action_index: 3001,
          prev_signing_pubkey: 'ab'.repeat(32), new_signing_pubkey: PUBKEY, block_index: 900021, timestamp: 1750210000 }
    ],
    rewards: [
        { id: '900', reward_type: 'oracle', round_reference: 'round-1', amount: '10.00000000', block_index: 900030, derive_block_index: 900029, timestamp: 1750300000 },
        { id: '901', reward_type: 'attest', round_reference: 'round-2', amount: '5.00000000',  block_index: 900040, derive_block_index: 900039, timestamp: 1750400000 }
    ],
    rewards_total:   '15.00000000',
    collected_total: '5.00000000',
    claimable:       '10.00000000',
    collects: [
        { action_index: 3300, amount: '5.00000000', block_index: 900050, timestamp: 1750500000, status: 'valid' }
    ],
    capability_slash_events: [],
    slash_events: [],
    nodeproofs: [
        { id: '55', action_index: 3400, challenge_id: 'cd'.repeat(32), epoch_height: 900100, target_height: 900090, staking_source: SOURCE, passed: 1, block_index: 900101, timestamp: 1750600000 },
        { id: '54', action_index: 3390, challenge_id: 'ce'.repeat(32), epoch_height: 900000, target_height: 899990, staking_source: SOURCE, passed: 0, block_index: 900001, timestamp: 1750500000 }
    ],
    attestation_quality: [
        { id: '5', validator_pubkey: PUBKEY, provider_id: 'coingecko', fulfilled_count: 90, missed_count: 10, slashed_count: 1, quality_score: '0.9000', last_updated_block: 900200 }
    ]
};

// Both slash families populated, each with the columns its own query selects.
const SLASHED = {
    ...BASE,
    capability_slash_events: [
        { id: '31', slash_action_index: 3500, capability: 'oracle_publish', equiv_key: 'aa'.repeat(32),
          amount: '100.00000000', bounty_amount: '10.00000000', treasury_amount: '90.00000000',
          submitter: 'bcrt1qsubmitter', destination: 'bcrt1qtreasury', block_index: 900300, timestamp: 1750700000 }
    ],
    slash_events: [
        { id: '41', execution_index: 3600, target_contract_index: 42, tick: 'XCHAIN',
          amount: '250.00000000', destination: 'bcrt1qburn', block_index: 900400, timestamp: 1750800000 },
        { id: '42', execution_index: 3610, target_contract_index: 42, tick: 'XCHAIN',
          amount: '50.00000000',  destination: 'bcrt1qburn', block_index: 900410, timestamp: 1750810000 }
    ]
};

// The hub registry could not be consulted at all. Capabilities come back empty
// in the same breath (the co-located read has nothing to serve either).
const REGISTRY_UNKNOWN = {
    ...BASE,
    registry: null,
    registry_known: false,
    capabilities: []
};

// A validator whose positions are all closed and which has done nothing else.
const EMPTY = {
    query: PUBKEY,
    signing_pubkey: PUBKEY,
    source: SOURCE,
    stake_action_index: 3001,
    version: 1,
    activation_block: 900010,
    deactivation_block: 900500,
    block_index: 900000,
    registry: null,
    registry_known: true,
    active_stake: '0.00000000',
    position_count: 0,
    capabilities: [],
    stakes: [], unstakes: [], delegations: [], revocations: [], rotations: [], rewards: [],
    rewards_total: '0.00000000', collected_total: '0.00000000', claimable: '0.00000000', collects: [],
    capability_slash_events: [], slash_events: [], nodeproofs: [], attestation_quality: []
};

module.exports = { expect, PUBKEY, SOURCE, makeWindow, page, BASE, SLASHED, REGISTRY_UNKNOWN, EMPTY };

