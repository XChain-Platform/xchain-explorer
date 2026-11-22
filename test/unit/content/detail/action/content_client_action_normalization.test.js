/* SPDX-License-Identifier: AGPL-3.0-or-later */

'use strict';

const fs = require('fs');
const path = require('path');
const { expect } = require('chai');
const { JSDOM } = require('jsdom');

const content = path.resolve(__dirname, '..', '..', '..', '../../src/content');
const apiProof = fs.readFileSync(path.join(content, 'js', 'xchain', 'api_proof.js'), 'utf8');
const detailCore = fs.readFileSync(path.join(content, 'js', 'xchain', 'detail', 'detail_core.js'), 'utf8');
const transaction = fs.readFileSync(path.join(content, 'html', 'transaction.html'), 'utf8');

function normalize(value){
    const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only' });
    dom.window.eval(apiProof);
    return dom.window.normalizeActionInfo(value);
}

describe('action response display normalization', function(){
    it('preserves structured and null-meaningful fields while blanking display cells', function(){
        const row = normalize({
            source: null,
            params: [null],
            details_json: { note: null },
            controller: null,
            action_class: null,
            callback_params_json: null,
            toString: null,
            credits: [{ memo: null }]
        });
        expect(row.source).to.equal('');
        expect(row.params).to.deep.equal([null]);
        expect(row.details_json).to.deep.equal({ note: null });
        expect(row.controller).to.equal(null);
        expect(row.action_class).to.equal(null);
        expect(row.callback_params_json).to.equal(null);
        expect(row.toString).to.equal('');
        expect(row.credits[0].memo).to.equal('');
    });

    it('keeps nested structured values unchanged for XCALL and BET rendering', function(){
        const row = normalize({
            params: [null, { nested: null }],
            details_json: { note: null },
            callback_params: { items: [null] }
        });
        expect(JSON.stringify(row.params)).to.equal('[null,{"nested":null}]');
        expect(JSON.stringify(row.details_json)).to.equal('{"note":null}');
        expect(JSON.stringify(row.callback_params)).to.equal('{"items":[null]}');
    });

    it('preserves null so BET fallback and ADDRESS absence checks remain reachable', function(){
        const row = normalize({ details: 'aGVsbG8=', details_json: null,
            action_format: 1, action_class: null, controller: null });
        expect(row.details_json != null).to.equal(false);
        expect(row.action_class != null).to.equal(false);
        expect(row.controller != null).to.equal(false);
    });

    it('wires action and transaction responses through the structured normalizer', function(){
        expect(detailCore).to.include('XC.actionInfo = normalizeActionInfo(raw);');
        expect(transaction).to.include('XC.transactionInfo = normalizeActionInfo(o);');
        expect(detailCore).to.not.include('XC.actionInfo = null2string(raw);');
        expect(transaction).to.not.include('XC.transactionInfo = null2string(o);');
    });
});
