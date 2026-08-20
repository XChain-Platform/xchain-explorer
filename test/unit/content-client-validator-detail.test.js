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
 * Drives the SHIPPED derivation + render (src/content/js/validator-detail-render.js)
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

const fs   = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { expect } = require('chai');

const SRC_DIR     = path.resolve(__dirname, '../../src/content');
const XCHAIN_SRC  = fs.readFileSync(path.join(SRC_DIR, 'js/xchain.js'), 'utf8');
const RENDER_SRC  = fs.readFileSync(path.join(SRC_DIR, 'js/validator-detail-render.js'), 'utf8');
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
// _collectTrail / _validatorCapabilityRows: nothing here is invented.
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

describe('validator.html detail page @regression', function () {

    describe('capability state: three independent flags', function () {

        it('ranks all five flag combinations, and a NULL self-test is not a failure', function () {
            const w = makeWindow();
            const state = r => w.validatorCapabilityState(r).key;
            expect(state({ qualified: 1, self_test_ok: 1,    enabled: 1 })).to.equal('active');
            expect(state({ qualified: 1, self_test_ok: 0,    enabled: 1 })).to.equal('self_test_bad');
            expect(state({ qualified: 1, self_test_ok: null, enabled: 1 })).to.equal('untested');
            expect(state({ qualified: 1, self_test_ok: 1,    enabled: 0 })).to.equal('disabled');
            expect(state({ qualified: 0, self_test_ok: 1,    enabled: 1 })).to.equal('not_qualified');
        });

        it('reads the hub RPC boolean transport the same as the 0/1 schema transport', function () {
            const w = makeWindow();
            expect(w.validatorCapabilityState({ qualified: true,  self_test_ok: true,  enabled: true  }).key).to.equal('active');
            expect(w.validatorCapabilityState({ qualified: true,  self_test_ok: false, enabled: true  }).key).to.equal('self_test_bad');
            expect(w.validatorCapabilityState({ qualified: false, self_test_ok: true,  enabled: true  }).key).to.equal('not_qualified');
        });

        it('a failing self-test outranks a disabled flag (disabling a broken capability does not make it healthy)', function () {
            const w = makeWindow();
            expect(w.validatorCapabilityState({ qualified: 1, self_test_ok: 0, enabled: 0 }).key).to.equal('self_test_bad');
        });

        it('renders one badge per capability carrying its own derived state', async function () {
            const w = await page('success', BASE);
            const $ = w.$;
            const states = $('#validator-capabilities .vd-capability').map(function () {
                return $(this).attr('data-capability') + ':' + $(this).attr('data-state');
            }).get();
            expect(states).to.deep.equal([
                'oracle_publish:active',
                'attest:self_test_bad',
                'nodeproof:untested',
                'relay:disabled',
                'checkpoint:not_qualified'
            ]);
            // The unknown self-test is drawn as unknown, never as a "no".
            const untestedRow = $('#validator-capabilities .vd-capability-row[data-state="untested"]');
            expect(untestedRow.length).to.equal(1);
            expect(untestedRow.find('.vd-cap-selftest .vd-flag').attr('data-flag')).to.equal('unknown');
        });
    });

    describe('registry_known:false is UNKNOWN, not "unregistered" and not "nothing"', function () {

        it('renders the unknown registry state with its explanatory note', async function () {
            const w = await page('success', REGISTRY_UNKNOWN);
            const $ = w.$;
            expect($('#validator-registry .vd-registry').attr('data-registry')).to.equal('unknown');
            expect($('#validator-registry .alert-warning').length).to.equal(1);
            expect($('#validator-registry .vd-registry-note').text()).to.contain('This is not a statement that it is unregistered');
        });

        it('does NOT render an empty capability list as "qualified for nothing" when the registry was unreadable', async function () {
            const w = await page('success', REGISTRY_UNKNOWN);
            const $ = w.$;
            expect($('#validator-capabilities .vd-capabilities-unknown').length).to.equal(1);
            expect($('#validator-capabilities').text()).to.contain('UNKNOWN');
            expect($('#validator-capabilities').text()).to.not.contain('has not qualified for any capability');
        });

        it('a registry that WAS read and lacks this key renders as unregistered, a different state', async function () {
            const w = await page('success', { ...BASE, registry: null, registry_known: true, capabilities: [] });
            const $ = w.$;
            expect($('#validator-registry .vd-registry').attr('data-registry')).to.equal('unregistered');
            expect($('#validator-registry .alert-warning').length).to.equal(0);
            // With a readable registry, an empty list IS a real "qualified for nothing".
            expect($('#validator-capabilities .vd-capabilities-unknown').length).to.equal(0);
            expect($('#validator-capabilities').text()).to.contain('has not qualified for any capability');
        });

        it('chains falls back to an unknown badge rather than a blank when the registry is unreadable', async function () {
            const known   = await page('success', BASE);
            const unknown = await page('success', REGISTRY_UNKNOWN);
            expect(known.$('#validator-identity .vd-chains').text()).to.equal('BTC,LTC');
            expect(unknown.$('#validator-identity .vd-chains').text()).to.equal('unknown');
        });
    });

    describe('both slash families, never merged', function () {

        it('renders two separately counted families and tags every row with the family it came from', async function () {
            const w = await page('success', SLASHED);
            const $ = w.$;
            const families = $('#validator-slashes .vd-slash-family');
            expect(families.length).to.equal(2);
            expect(families.map(function () { return $(this).attr('data-family'); }).get())
                .to.deep.equal(['capability', 'contract']);
            expect($('#validator-slashes .vd-slash-family[data-family="capability"] .vd-slash-count').text()).to.equal('1');
            expect($('#validator-slashes .vd-slash-family[data-family="contract"]   .vd-slash-count').text()).to.equal('2');
            expect($('#validator-slashes .vd-slash-row[data-family="capability"]').length).to.equal(1);
            expect($('#validator-slashes .vd-slash-row[data-family="contract"]').length).to.equal(2);
            // Every rendered row lives inside its own family container: no row of
            // one family may appear under the other's heading.
            expect($('#validator-slashes .vd-slash-family[data-family="capability"] .vd-slash-row[data-family="contract"]').length).to.equal(0);
            expect($('#validator-slashes .vd-slash-family[data-family="contract"] .vd-slash-row[data-family="capability"]').length).to.equal(0);
        });

        it('keeps the two families\' distinct columns (equivocation key vs contract/token)', async function () {
            const w = await page('success', SLASHED);
            const $ = w.$;
            const cap = $('#validator-slashes .vd-slash-family[data-family="capability"]');
            const con = $('#validator-slashes .vd-slash-family[data-family="contract"]');
            expect(cap.text()).to.contain('Equivocation Key');
            expect(cap.text()).to.contain('Bounty');
            expect(cap.text()).to.contain('oracle_publish');
            expect(con.text()).to.contain('EXECUTE Action');
            expect(con.text()).to.contain('XCHAIN');
            // The contract family carries no equivocation key, and saying it does
            // would be inventing a column its query never selects.
            expect(con.text()).to.not.contain('Equivocation Key');
        });

        it('a validator with neither family renders the clean badge and still shows both headings', async function () {
            const w = await page('success', BASE);
            const $ = w.$;
            expect($('#validator-slashes .vd-slash-clean').length).to.equal(1);
            expect($('#validator-slashes .vd-slash-family').length).to.equal(2);
            expect($('#validator-slashes .vd-slash-row').length).to.equal(0);
        });

        it('one family alone does not suppress the clean badge for the other', async function () {
            const w = await page('success', { ...BASE, slash_events: SLASHED.slash_events });
            const $ = w.$;
            expect($('#validator-slashes .vd-slash-clean').length).to.equal(0);
            expect($('#validator-slashes .vd-slash-family[data-family="capability"] .vd-slash-count').text()).to.equal('0');
            expect($('#validator-slashes .vd-slash-family[data-family="contract"] .vd-slash-count').text()).to.equal('2');
        });
    });

    describe('stake, rewards and the COLLECT trail', function () {

        it('tells active positions from superseded ones and from rejected STAKE actions', async function () {
            const w = await page('success', BASE);
            const $ = w.$;
            const states = $('#validator-stake .vd-stake-row').map(function () {
                return $(this).attr('data-stake-state');
            }).get();
            expect(states).to.deep.equal(['active', 'active', 'ended', 'rejected']);
            expect($('#validator-stake .vd-active-stake').text()).to.equal('1,000.00000000');
            expect($('#validator-stake .vd-position-count').text()).to.equal('(2 open position(s))');
        });

        it('renders the COLLECT trail and a positive claimable as a plain figure', async function () {
            const w = await page('success', BASE);
            const $ = w.$;
            expect($('#validator-rewards .vd-reward-row').length).to.equal(2);
            expect($('#validator-rewards .vd-collect-row').length).to.equal(1);
            expect($('#validator-rewards .vd-claimable').attr('data-claimable')).to.equal('positive');
            expect($('#validator-rewards .vd-claimable').text()).to.equal('10.00000000');
        });

        it('a NEGATIVE claimable is drawn as ledger drift, not as a balance', async function () {
            const w = await page('success', { ...BASE, rewards_total: '5.00000000', collected_total: '15.00000000', claimable: '-10.00000000' });
            const $ = w.$;
            const claim = $('#validator-rewards .vd-claimable');
            expect(claim.attr('data-claimable')).to.equal('drift');
            expect(claim.hasClass('text-bg-danger')).to.equal(true);
            expect($('#validator-rewards').text()).to.contain('ledger drift');
        });

        it('a zero claimable is neither positive nor drift', async function () {
            const w = await page('success', EMPTY);
            expect(w.$('#validator-rewards .vd-claimable').attr('data-claimable')).to.equal('zero');
        });
    });

    describe('delegation, rotation, node proofs and attestation quality', function () {

        it('renders delegations with their revocations and rotations, each as its own list', async function () {
            const w = await page('success', BASE);
            const $ = w.$;
            expect($('#validator-delegations .vd-delegation-row').length).to.equal(2);
            expect($('#validator-delegations .vd-delegation-row').map(function () {
                return $(this).attr('data-delegation-state');
            }).get()).to.deep.equal(['active', 'ended']);
            expect($('#validator-delegations .vd-revocation-row').length).to.equal(1);
            expect($('#validator-delegations .vd-rotation-row').length).to.equal(1);
            // The rotation names both sides; this validator is the NEW key here.
            expect($('#validator-delegations .vd-rotation-row .vd-rotation-new').text()).to.contain(PUBKEY.substring(0, 20));
        });

        it('renders NODEPROOF history with pass/fail per row and a passed-count summary', async function () {
            const w = await page('success', BASE);
            const $ = w.$;
            expect($('#validator-nodeproofs .vd-nodeproof-row').map(function () {
                return $(this).attr('data-passed');
            }).get()).to.deep.equal(['yes', 'no']);
            expect($('#validator-nodeproofs .vd-nodeproof-summary').text()).to.equal('1 of 2 recorded verification(s) passed.');
        });

        it('derives an attestation fulfilled rate per provider, and NULL (not 0%) when there were no attempts', function () {
            const w = makeWindow();
            const rows = w.validatorAttestationSummary([
                { id: '1', provider_id: 'a', fulfilled_count: 90, missed_count: 10, slashed_count: 1, quality_score: '0.9' },
                { id: '2', provider_id: 'b', fulfilled_count: 0,  missed_count: 0,  slashed_count: 0, quality_score: null }
            ]);
            expect(rows[0].attempts).to.equal(100);
            expect(rows[0].fulfilled_rate).to.equal(0.9);
            expect(rows[1].attempts).to.equal(0);
            expect(rows[1].fulfilled_rate).to.equal(null);
        });

        it('renders the attestation row and prints no-attempts rather than a 0% rate', async function () {
            const w = await page('success', BASE);
            expect(w.$('#validator-attestation .vd-attestation-row').length).to.equal(1);
            expect(w.$('#validator-attestation .vd-attestation-rate').text()).to.equal('90.0%');
            const none = await page('success', {
                ...BASE,
                attestation_quality: [{ id: '9', validator_pubkey: PUBKEY, provider_id: 'idle', fulfilled_count: 0, missed_count: 0, slashed_count: 0, quality_score: null, last_updated_block: 900200 }]
            });
            expect(none.$('#validator-attestation .vd-attestation-rate').text()).to.equal('no attempts');
        });
    });

    describe('an empty / never-active validator', function () {

        it('reports no active stake without claiming the record is missing', async function () {
            const w = await page('success', EMPTY);
            const $ = w.$;
            expect($('#validator-identity .vd-status').attr('data-status')).to.equal('deactivated');
            expect($('#validator-identity').text()).to.contain(PUBKEY);
            expect($('#validator-stake .vd-stake-row').length).to.equal(0);
            expect($('#validator-stake').text()).to.contain('No STAKE positions.');
            expect($('#validator-nodeproofs').text()).to.contain('No NODEPROOF verifications recorded.');
            expect($('#validator-attestation').text()).to.contain('No attestation accountability counters');
        });

        it('status is active only while open positions exist', function () {
            const w = makeWindow();
            expect(w.validatorStatusState({ position_count: 2, deactivation_block: null }).key).to.equal('active');
            expect(w.validatorStatusState({ position_count: 0, deactivation_block: 900500 }).key).to.equal('deactivated');
            expect(w.validatorStatusState({ position_count: 0, deactivation_block: null }).key).to.equal('inactive');
        });
    });

    describe('response shapes and the not-found branch', function () {

        it('accepts the BARE object a single-resource route answers with', async function () {
            const w = await page('success', BASE);
            expect(w.__requestedUrl).to.equal('/BTC/api/validator/' + PUBKEY);
            expect(w.$('#validator-identity .vd-status').attr('data-status')).to.equal('active');
        });

        it('also accepts the {total,data} envelope, rendering the same record', async function () {
            const w = await page('success', { total: 1, data: [BASE] });
            expect(w.$('#validator-identity .vd-status').attr('data-status')).to.equal('active');
            expect(w.$('#validator-capabilities .vd-capability').length).to.equal(5);
        });

        it('renders an explicit not-found message, not a page of "-" placeholders', async function () {
            const w = await page('success', null);
            const $ = w.$;
            expect($('#validator-identity').text()).to.equal('No validator is recorded for this signing pubkey or address.');
            expect($('#validator-identity .text-danger').length).to.equal(0);
            expect($('#validator-capabilities').text()).to.equal('-');
        });

        it('surfaces the server\'s own error text on a failed request, as a danger row', async function () {
            const w = await page('fail', { responseJSON: { error: 'Hub unreachable: capability state unavailable', code: 'HUB_OUTAGE' } });
            const $ = w.$;
            expect($('#validator-identity .text-danger').length).to.equal(1);
            expect($('#validator-identity .text-danger').text()).to.equal('Hub unreachable: capability state unavailable');
            // An outage is NOT a not-found: the two must not share wording.
            expect($('#validator-identity').text()).to.not.contain('No validator is recorded');
        });

        it('falls back to a page-owned message when the failure carries no error text', async function () {
            const w = await page('fail', {});
            expect(w.$('#validator-identity .text-danger').text()).to.equal('Could not load this validator');
        });
    });

    describe('escaping', function () {

        it('escapes a poisoned capability name rather than letting it reach the DOM as markup', async function () {
            const w = await page('success', {
                ...BASE,
                capabilities: [{ id: '1', signing_pubkey: PUBKEY, capability: '<img src=x onerror=alert(1)>', qualified: 1, self_test_ok: 1, enabled: 1, qualified_at_block: '900010', updated_at: 1750000000 }]
            });
            const $ = w.$;
            expect($('#validator-capabilities img').length).to.equal(0);
            expect($('#validator-capabilities .vd-capability').text()).to.contain('<img src=x onerror=alert(1)>');
        });
    });
});
