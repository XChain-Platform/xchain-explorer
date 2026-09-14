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

const {
    expect, PUBKEY, SOURCE, makeWindow, page, BASE, SLASHED, REGISTRY_UNKNOWN, EMPTY
} = require('./content_client_validator_detail.test/helpers.js');

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
});

describe('validator.html detail page @regression', function () {
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
});

describe('validator.html detail page @regression', function () {
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
});

describe('validator.html detail page @regression', function () {
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
});

describe('validator.html detail page @regression', function () {
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
});

describe('validator.html detail page @regression', function () {
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
});

describe('validator.html detail page @regression', function () {
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
});

describe('validator.html detail page @regression', function () {
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
