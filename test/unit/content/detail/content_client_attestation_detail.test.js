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
 * ATTEST attestation detail page. Drives the SHIPPED renders in
 * src/content/js/attestation_detail_render.js and the SHIPPED inline script of
 * src/content/html/attestation.html against stubbed endpoint payloads, in the
 * same JSDOM harness the other content-client-*-detail tests use.
 *
 * What it protects:
 *
 *  - EXPIRY IS THE STORED TERMINAL STATE, NOT A CLOCK COMPARISON. ATTEST v2
 *    persists no row: it flips the v0 request row's request_status to 'expired'
 *    and stamps resolved_block. A request whose deadline_block has passed but
 *    which the expiry sweep has not reached is STILL 'pending'. A page that
 *    derived expiry by comparing deadline_block against a chain tip would show
 *    that live request as dead. The [pending-past-deadline] case below is the
 *    whole reason this file exists.
 *
 *  - RELAY LEGS ARE MARKED, AND ONLY WHERE THEY EXIST. Relay rows (ATTEST v3/v4)
 *    are ordinary v0/v1 rows carrying origin_chain / origin_action_index, so a
 *    render that ignores those columns loses the cross-chain half of the
 *    lifecycle. Equally, a NATIVE attestation must not read as one with missing
 *    relay data: most attestations have no relay leg at all.
 *
 *  - SIGNATURES ARE OPAQUE MATERIAL. The full pubkey and full signature are
 *    rendered, and nothing on the page claims they were checked.
 *
 *  - NOT FOUND is an explicit branch, not a page of blank placeholders.
 *
 * Venue note: the `attests` table is empty on the regtest venue and no ATTEST
 * round can be driven there, so this harness is the only thing that exercises
 * the page at all.
 */

'use strict';

const {
    expect, renderDom, paint, loadPage, REQ_ID, requestLeg, responseLeg,
    completed, expired, expiredLinked, pendingPastDeadline, relayed, URL_FOR
} = require('./content_client_attestation_detail.test/support/helpers.js');

/* -------------------------------- tests -------------------------------- */

describe('attestation.html detail page @regression', function () {

    describe('expiry: the stored terminal state, never a deadline comparison', function () {

        it('[pending-past-deadline] a pending request whose deadline block has passed is NOT rendered as expired', function () {
            const dom = renderDom();
            const $ = paint(dom, dom.window.renderAttestationExpiry(pendingPastDeadline()));

            // The deadline (400) is behind the request block (350 was mined, and
            // the round records nothing past it); a clock-style derivation would
            // light the expired branch here.
            expect($('.attestation-expired').length, 'no expired verdict for a pending request').to.equal(0);
            expect($('.attestation-not-expired').length).to.equal(1);
            expect($('.attestation-not-expired').attr('data-expired')).to.equal('false');
            expect($('.attestation-status').attr('data-status')).to.equal('pending');
            expect($('.attestation-not-expired').text()).to.contain('Passing the deadline block does not expire a request by itself');
            // The deadline is still SHOWN; it is just never fed into a verdict.
            expect($('.attestation-deadline-block').text()).to.contain('400');
        });

        it('[pending-past-deadline] the lifecycle expiry stage stays unreached', function () {
            const dom = renderDom();
            const $ = paint(dom, dom.window.renderAttestationLifecycle(pendingPastDeadline()));
            expect($('[data-stage="expiry"]').attr('data-reached')).to.equal('false');
            expect($('[data-stage="expiry"]').hasClass('attestation-stage-unreached')).to.equal(true);
            expect($('[data-stage="request"]').attr('data-reached')).to.equal('true');
            expect($('[data-stage="response"]').attr('data-reached')).to.equal('false');
        });

        it('[pending-past-deadline] attestationStages reports request reached and expiry not reached', function () {
            const dom = renderDom();
            const stages = dom.window.attestationStages(pendingPastDeadline());
            const byKey = {};
            stages.forEach(function (s) { byKey[s.key] = s; });
            expect(Object.keys(byKey).sort()).to.deep.equal(['callback', 'expiry', 'request', 'response']);
            expect(byKey.request.reached).to.equal(true);
            expect(byKey.response.reached).to.equal(false);
            expect(byKey.expiry.reached).to.equal(false);
            expect(byKey.expiry.note).to.equal('not recorded as expired');
            expect(byKey.callback.reached).to.equal(false);
        });
    });
});

describe('attestation.html detail page @regression', function () {
    describe('expiry: the stored terminal state, never a deadline comparison', function () {
        it('[expired] the stored expired state renders the expired verdict and the reached expiry stage', function () {
            const dom = renderDom();
            const d = expired();
            const $ = paint(dom, dom.window.renderAttestationExpiry(d));
            expect($('.attestation-expired').length).to.equal(1);
            expect($('.attestation-expired').attr('data-expired')).to.equal('true');
            expect($('.attestation-not-expired').length).to.equal(0);
            expect($('.attestation-status').attr('data-status')).to.equal('expired');
            expect($('.attestation-resolved-block').text()).to.contain('901');

            const $l = paint(dom, dom.window.renderAttestationLifecycle(d));
            expect($l('[data-stage="expiry"]').attr('data-reached')).to.equal('true');
            expect($l('[data-stage="response"]').attr('data-reached')).to.equal('false');
        });

        it('[expired] says v2 wrote no ROW without claiming the expiry action cannot be linked', function () {
            const dom = renderDom();
            const $ = paint(dom, dom.window.renderAttestationExpiry(expiredLinked()));
            const copy = $('.attestation-expired').text();
            expect(copy).to.contain('ATTEST v2 writes no row of its own');
            // The old copy denied the expiry ACTION existed. It does, and it has a page.
            expect(copy).to.not.contain('no expiry action to link to');
        });

        it('[expired] links the expire ACTION on the panel and names it on the ladder', function () {
            const dom = renderDom();
            const d = expiredLinked();
            const $ = paint(dom, dom.window.renderAttestationExpiry(d));
            expect($('.attestation-expire-action a').attr('href')).to.equal('/RBTC/action/5101');
            expect($('.attestation-expire-action-none').length).to.equal(0);
            expect($('.attestation-expired a[href="/RBTC/action/5101"]').length).to.equal(1);

            const $l = paint(dom, dom.window.renderAttestationLifecycle(d));
            expect($l('[data-stage="expiry"]').text()).to.contain('action 5101');
        });
    });
});

describe('attestation.html detail page @regression', function () {
    describe('expiry: the stored terminal state, never a deadline comparison', function () {
        it('[expired] links the injected callback EXECUTE, which no response panel exists to carry', function () {
            const dom = renderDom();
            const d = expiredLinked();
            const $ = paint(dom, dom.window.renderAttestationExpiry(d));
            expect($('.attestation-expiry-callback a').attr('href')).to.equal('/RBTC/action/5102');
            expect($('.attestation-expiry-callback-none').length).to.equal(0);

            // And the ladder counts the callback stage as reached, saying where the link
            // came from rather than implying the indexer stamped it.
            const stages = {};
            dom.window.attestationStages(d).forEach(function (s) { stages[s.key] = s; });
            expect(stages.callback.reached).to.equal(true);
            expect(stages.callback.note).to.contain('5102');
            expect(stages.callback.note).to.contain('matched by request id');
        });

        it('[expired-unresolved] an unresolvable expiry says so instead of linking a guess', function () {
            const dom = renderDom();
            const d = expired();
            const $ = paint(dom, dom.window.renderAttestationExpiry(d));
            expect($('.attestation-expire-action-none').length).to.equal(1);
            expect($('.attestation-expired a[href^="/RBTC/action/"]').length).to.equal(0);
            expect($('.attestation-expiry-callback-none').length).to.equal(1);
            expect($('.attestation-expired').text()).to.contain('could not be identified');

            const stages = {};
            dom.window.attestationStages(d).forEach(function (s) { stages[s.key] = s; });
            expect(stages.expiry.reached).to.equal(true);
            expect(stages.callback.reached).to.equal(false);
        });

        it('[completed] the expiry panel carries no expire or callback row when nothing expired', function () {
            const dom = renderDom();
            const $ = paint(dom, dom.window.renderAttestationExpiry(completed()));
            expect($('.attestation-expire-action, .attestation-expire-action-none').length).to.equal(0);
            expect($('.attestation-expiry-callback, .attestation-expiry-callback-none').length).to.equal(0);
        });

        it('[completed] a fulfilled request is not expired and reaches response and callback', function () {
            const dom = renderDom();
            const d = completed();
            const $ = paint(dom, dom.window.renderAttestationExpiry(d));
            expect($('.attestation-expired').length).to.equal(0);
            expect($('.attestation-status').attr('data-status')).to.equal('fulfilled');

            const $l = paint(dom, dom.window.renderAttestationLifecycle(d));
            expect($l('[data-stage="request"]').attr('data-reached')).to.equal('true');
            expect($l('[data-stage="response"]').attr('data-reached')).to.equal('true');
            expect($l('[data-stage="expiry"]').attr('data-reached')).to.equal('false');
            expect($l('[data-stage="callback"]').attr('data-reached')).to.equal('true');
        });
    });
});

describe('attestation.html detail page @regression', function () {
    describe('request and response panels', function () {

        it('[completed] the v0 request shows provider, redundancy requirement, deadline and payload', function () {
            const dom = renderDom();
            const $ = paint(dom, dom.window.renderAttestationRequest(completed()));
            const text = $('#out').text();
            expect(text).to.contain('http_get');
            expect(text).to.contain('Redundancy Required');
            expect(text).to.contain('Deadline Block');
            expect($('.attestation-request-payload').text()).to.equal('https://example.invalid/price');
            expect($('.attestation-callback').text()).to.contain('onPrice()');
            expect($('.attestation-callback').text()).to.contain('"pair":"XCP/BTC"');
        });

        it('[completed] the pinned responsible set is listed in full, with no signed/unsigned claim', function () {
            const dom = renderDom();
            const $ = paint(dom, dom.window.renderAttestationRequest(completed()));
            const members = $('.attestation-responsible-member');
            expect(members.length).to.equal(2);
            expect(members.eq(0).text()).to.equal('c'.repeat(64));
            expect($('#out').text()).to.not.contain('did not sign');
        });

        it('[completed] the v1 response shows status, hash, payload and every quorum signature in full', function () {
            const dom = renderDom();
            const $ = paint(dom, dom.window.renderAttestationResponse(completed()));
            expect($('.attestation-response-status').attr('data-response-status')).to.equal('ok');
            expect($('.attestation-response-payload').text()).to.equal('{"price":"0.00012"}');

            const sigs = $('.attestation-signature');
            expect(sigs.length).to.equal(2);
            // Full material, not truncated into something that reads as checked.
            expect(sigs.eq(0).find('.attestation-signature-pubkey').text()).to.equal('c'.repeat(64));
            expect(sigs.eq(0).find('.attestation-signature-sig').text()).to.equal('11'.repeat(32));
            expect($('.attestation-signatures-note').text())
                .to.contain('Attached is not the same as verified');
        });

        it('[expired] the response panel states there is no v1 row rather than rendering blanks', function () {
            const dom = renderDom();
            const $ = paint(dom, dom.window.renderAttestationResponse(expired()));
            expect($('.attestation-no-response').length).to.equal(1);
            expect($('.attestation-signature').length).to.equal(0);
        });
    });
});

describe('attestation.html detail page @regression', function () {
    describe('request and response panels', function () {
        // attests.batch_action_index. Three distinct states, and the two NULL ones
        // mean opposite things: a mirror-applied response (no transaction of its
        // own) is WAITING for the ATTEST v5/v6 batch that carries its body, while a
        // legacy-era response WAS its own on-chain transaction and will never have
        // one. Collapsing them into a single dash tells a reader something untrue.
        // The batch index belongs to the DOGE rail, not to the page's chain: the
        // schema column is "the DOGE action_index of the ATTEST v5 batch that carried
        // this row". Namespacing it by the page coin produced a link to an unrelated
        // action of the same index on this chain, which resolves and is wrong, so the
        // wrong URL is asserted ABSENT rather than only the right one present.
        it('[batch] links the batch action on the DOGE rail once the batch has landed', function () {
            const dom = renderDom();
            const d = completed();
            d.response = responseLeg({ tx_hash: null, tx_index: null, batch_action_index: 6100 });
            d.legs = [d.request, d.response];
            const $ = paint(dom, dom.window.renderAttestationResponse(d));
            expect($('#out').text()).to.contain('On-chain Batch');
            expect($('a[href="/RDOGE/action/6100"]').length).to.equal(1);
            expect($('a[href="/RBTC/action/6100"]').length).to.equal(0);
            expect($('.attestation-batch-pending').length).to.equal(0);
            expect($('.attestation-batch-na').length).to.equal(0);
        });

        // The network tier comes from the page coin, so this pins the prefix rather
        // than a hard-coded 'R': a testnet page must reach TDOGE, and mainnet DOGE.
        it('[batch] keeps the page network tier when crossing to the DOGE rail', function () {
            for(const [pageCoin, expected] of [['TBTC', 'TDOGE'], ['BTC', 'DOGE'], ['RLTC', 'RDOGE']]){
                const dom = renderDom();
                dom.window.eval('XC.coin = ' + JSON.stringify(pageCoin) + ';');
                const d = completed();
                d.response = responseLeg({ tx_hash: null, tx_index: null, batch_action_index: 6100 });
                d.legs = [d.request, d.response];
                const $ = paint(dom, dom.window.renderAttestationResponse(d));
                expect($('a[href="/' + expected + '/action/6100"]').length,
                    'page coin ' + pageCoin + ' should link ' + expected).to.equal(1);
            }
        });
    });
});

describe('attestation.html detail page @regression', function () {
    describe('request and response panels', function () {
        it('[batch] says the body is not on chain YET for a mirror-applied response', function () {
            const dom = renderDom();
            const d = completed();
            d.response = responseLeg({ tx_hash: null, tx_index: null, batch_action_index: null });
            d.legs = [d.request, d.response];
            const $ = paint(dom, dom.window.renderAttestationResponse(d));
            expect($('.attestation-batch-pending').text()).to.contain('not yet carried by an on-chain batch');
            expect($('.attestation-batch-na').length).to.equal(0);
        });

        it('[batch] says NOT APPLICABLE for a response that was its own transaction', function () {
            const dom = renderDom();
            const $ = paint(dom, dom.window.renderAttestationResponse(completed()));
            expect($('.attestation-batch-na').text()).to.contain('its own on-chain transaction');
            expect($('.attestation-batch-pending').length).to.equal(0);
        });

        it('[retry-rounds] every v1 row is listed, not just the one the server named as `response`', function () {
            const dom = renderDom();
            const d = completed();
            const retry = responseLeg({ action_index: 5120, response_status: 'no_quorum', quorum_signatures: [] });
            d.legs = [d.request, retry, d.response];
            const $ = paint(dom, dom.window.renderAttestationResponse(d));
            const rounds = $('.attestation-response-round');
            expect(rounds.length).to.equal(2);
            expect($('.attestation-response-rounds-note').text()).to.contain('2 response rounds');
        });
    });
});

require('./content_client_attestation_detail.test/support/page_and_relay.js');
