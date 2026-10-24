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

const proxyquire = require('proxyquire');
const sinon = require('sinon');
const { expect } = require('chai');
const { JSDOM } = require('jsdom');

const Utility = require('../../../../../src/lib/utility.js');
const { createConfigInfoStub } = require('../../../../fixtures/mock-config.js');
const { srcText } = require('../../../../helpers/source_text.js');

const Database = proxyquire('../../../../../src/db/index.js', {
    './connection.js': proxyquire('../../../../../src/db/connection.js', {
        mariadb: { createPool: () => ({}) }
    })
});

const configInfo = createConfigInfoStub();
const util = new Utility(configInfo);
const PUBLISHER = 'a'.repeat(64);

function config(){
    return {
        coin: 'DOGE',
        type: 'api',
        data: {
            search: '100',
            sql: { limit: 25 }
        }
    };
}

function database(row, sections, network){
    const db = new Database({ configInfo, util, hubOperational: null });
    db.checkpointDb = { DOGE: { name: 'XChain_Hub', chain: 'DOGE', network } };
    db.doQuery = sinon.stub().callsFake(async (cfg, query) => {
        const flat = String(query).replace(/\s+/g, ' ').trim();
        if(flat.includes('FROM anchor_actions m INNER JOIN actions')) return [row];
        if(flat.includes('WHERE m.action_index=? ORDER BY m.section_index ASC')) return sections || [];
        return [];
    });
    return db;
}

function capabilityQuery(db){
    const call = db.doQuery.getCalls().find(c =>
        String(c.args[1]).includes('capability_snapshots'));
    return call && call.args[2];
}

function anchor(version, network, extras){
    return Object.assign({
        action: 'ANCHOR', action_index: 100, section_index: 0, version,
        chain: 'DOGE', network, block_index: 90, snapshot_block: 10,
        match_batch_seq: null, validator_signatures: '[]',
        publisher: PUBLISHER, publisher_attestations: '[]', tx_hash: 'b'.repeat(64)
    }, extras || {});
}

function assertArchiveElectionLabels(){
    const dom = new JSDOM('<div id="election"></div>', { runScripts: 'outside-only' });
    dom.window.eval(`
        function isNull(v){ return v === null || v === undefined; }
        function $(tag){
            var value = '';
            return {
                text: function(v){ value = v == null ? '' : String(v); return this; },
                html: function(){ return value.replace(/[&<>"']/g, function(c){ return '&#' + c.charCodeAt(0) + ';'; }); }
            };
        }
        function formatAmount(v){ return String(v); }
    `);
    dom.window.eval(srcText('src/content/js/anchor_detail_render.js'));
    dom.window.anchorTraits = function () {
        return { known: true, version: 1, publisher: true };
    };
    dom.window.anchorBlockLink = function (v) { return String(v); };

    const html = dom.window.renderAnchorElection({
        version: 1, snapshot_block: 10, publisher: PUBLISHER,
        publisher_attestations: [], publisher_election_capability: 'archive_publish',
        publisher_election: [{ signing_pubkey: PUBLISHER, amount: '5', source: 'stake' }]
    });
    dom.window.document.querySelector('#election').innerHTML = html;

    expect(dom.window.document.querySelector('.anchor-note').textContent)
        .to.contain('archive_publish set');
    expect(dom.window.document.querySelector('.small.text-muted.mt-2.mb-1').textContent)
        .to.contain('in the archive_publish set');
}

describe('anchor archive publisher electorate', function () {
    it('selects archive_publish for a v1 archive head above the gate', async function () {
        const db = database(anchor(1, 'regtest', { match_batch_seq: 7 }), [], 'regtest');
        const [row] = await db.getAnchor(config());

        expect(capabilityQuery(db)).to.deep.equal([10, 'archive_publish']);
        expect(row.publisher_election_capability).to.equal('archive_publish');
    });

    it('selects archive_publish for a v3 fold wrapper with an archive row above the gate', async function () {
        const sections = [
            { section_index: 0, chain: 'DOGE', snapshot_block: 10, validator_signatures: '[]' },
            { section_index: 1, chain: null, snapshot_block: 10, match_batch_seq: 8,
              validator_signatures: '[]' }
        ];
        const db = database(anchor(3, 'regtest'), sections, 'regtest');
        const [row] = await db.getAnchor(config());

        expect(capabilityQuery(db)).to.deep.equal([10, 'archive_publish']);
        expect(row.publisher_election_capability).to.equal('archive_publish');
    });

    it('keeps archive rows below the gate and non-archive rows on oracle_publish', async function () {
        const below = database(anchor(1, 'testnet', { match_batch_seq: 7 }), [], 'testnet');
        const plain = database(anchor(0, 'regtest'), [], 'regtest');

        const [belowRow] = await below.getAnchor(config());
        const [plainRow] = await plain.getAnchor(config());

        expect(capabilityQuery(below)).to.deep.equal([10, 'oracle_publish']);
        expect(belowRow.publisher_election_capability).to.equal('oracle_publish');
        expect(capabilityQuery(plain)).to.deep.equal([10, 'oracle_publish']);
        expect(plainRow.publisher_election_capability).to.equal('oracle_publish');
    });

    it('names the selected set in the election note and member label', assertArchiveElectionLabels);
});
