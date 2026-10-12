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
 * An ATTEST v5 batch head and v6 chunk keep their batch key in request_id and
 * carry no request or response of their own. The lifecycle leg table and the
 * action summary must say so instead of rendering them as plain attestations.
 *********************************************************************/

'use strict';

const fs   = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { expect } = require('chai');
const { srcText } = require('../../helpers/source_text');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

function extractFn(src, name) {
    const start = src.indexOf('function ' + name + '(');
    if (start < 0) throw new Error('function not found: ' + name);
    let depth = 0, i = src.indexOf('{', start);
    for (; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
    }
    return src.slice(start, i);
}

function legsDom(legs) {
    const dom = new JSDOM('<!DOCTYPE html><body><div id="out"></div></body>', { runScripts: 'outside-only' });
    dom.window.eval(read('src/content/js/jquery.min.js'));
    dom.window.eval(`
        var XC = { coin: 'TDOGE', query: 'k', name: 'Dogecoin', network: 'testnet', pageInfo: {} };
        function formatLink(href, text){ return '<a href="' + href + '">' + text + '</a>'; }
        function formatLivestamp(){ return '<span class="livestamp"></span>'; }
        var numeral = function(n){ return { format: function(){ return String(n); } }; };
        ${extractFn(srcText('src/content/js/xchain.js') + '\n' + read('src/content/js/formatters.js'), 'isNull')}
    `);
    dom.window.eval(read('src/content/js/attestation_detail_render/state.js'));
    dom.window.eval(read('src/content/js/attestation_detail_render/batch.js'));
    dom.window.eval(read('src/content/js/attestation_detail_render.js'));
    dom.window.$('#out').html(dom.window.renderAttestationLegs({ legs }));
    return dom.window.$;
}

const KEY = 'ab'.repeat(32);

describe('ATTEST v5 batch head rendering', function () {
    it('labels v5 and v6 legs as batch legs carrying the batch key', function () {
        const $ = legsDom([
            { action_index: 10, version: 5, action_format: 5, request_id: KEY, block_index: 1, status: 'valid', provider_id: '' },
            { action_index: 11, version: 6, action_format: 6, request_id: KEY, block_index: 1, status: 'valid', provider_id: '' }
        ]);
        const rows = $('tr.attestation-leg');
        expect(rows.length).to.equal(2);
        expect(rows.eq(0).find('td').eq(1).text()).to.contain('Batch head (v5)');
        expect(rows.eq(1).find('td').eq(1).text()).to.contain('Batch continuation (v6)');
        expect(rows.eq(0).hasClass('attestation-leg-batch')).to.equal(true);
        expect(rows.eq(0).find('.attestation-leg-batch-key').text()).to.contain(KEY);
        expect(rows.eq(0).find('td').eq(1).text()).to.not.contain('version 5');
    });

    it('keeps request and response legs unchanged', function () {
        const $ = legsDom([
            { action_index: 1, version: 0, request_id: KEY, request_status: 'pending', status: 'valid' },
            { action_index: 2, version: 1, request_id: KEY, response_status: 'ok', status: 'valid' }
        ]);
        const rows = $('tr.attestation-leg');
        expect(rows.eq(0).find('td').eq(1).text()).to.contain('Request (v0)');
        expect(rows.eq(1).find('td').eq(1).text()).to.contain('Response (v1)');
        expect(rows.eq(0).find('.attestation-leg-batch-key').length).to.equal(0);
        expect(rows.eq(0).find('td').eq(5).text()).to.contain('pending');
    });

    it('marks an ATTEST v5 summary with its batch key and leaves other actions alone', function () {
        const proto = require('../../../src/db/readers/action_detail_io/batches.js');
        const ctx = { util: { isNull: (v) => v === null || v === undefined || v === '' } };
        const head = proto.projectActionSummary.call(ctx, { action: 'ATTEST', action_format: 5, request_id: KEY, status: 'valid' });
        expect(head.details.batch_key).to.equal(KEY);
        const req = proto.projectActionSummary.call(ctx, { action: 'ATTEST', action_format: 0, request_id: KEY, status: 'valid' });
        expect(req.details && req.details.batch_key).to.equal(undefined);
    });
});
