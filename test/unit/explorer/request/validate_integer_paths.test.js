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
 * A numeric path segment bound to an integer column is refused before the
 * query when it is not a plain non-negative integer: MariaDB would cast
 * '7junk' to 7 and answer record 7's data. Text columns keep their segment.
 */

'use strict';

const { expect } = require('chai');
const proxyquire = require('proxyquire');
const Utility    = require('../../../../src/lib/utility.js');
const { createConfigInfoStub } = require('../../../fixtures/mock-config.js');
const { makeConfig }           = require('../../../fixtures/mock-query-args.js');
const { validateParams } = require('../../../../src/explorer/request/validate_params.js');

const util = new Utility(createConfigInfoStub());

function settle(transport, method, type, search){
    const explorer = { util, mirrorGate: () => ({ blocked: false }) };
    const st = { cfg: { coin: 'BTC', type: transport, data: { method, type, search } }, response: {} };
    return { settled: validateParams(explorer, st), st };
}

const BAD = ['7junk', '0x10', '1e3', '1.5', '-1', '٣', '７', '99999999999999999999', ' 7', "1' OR '1'='1"];

describe('validateParams integer path segments', function () {
    const CASES = [
        ['getSends', 'block', 'INVALID_BLOCK_INDEX'],
        ['getTransaction', 'tx_index', 'INVALID_TX_INDEX'],
        ['getPollResults', 'poll', 'INVALID_POLL_INDEX'],
        ['getBets', 'feed', 'INVALID_FEED_INDEX'],
        ['getPriceSnapshots', 'round', 'INVALID_ROUND_NUMBER'],
        ['getFullNodeVerifications', 'epoch', 'INVALID_EPOCH_HEIGHT'],
        ['getEmissions', 'execution', 'INVALID_EXECUTION_INDEX'],
        ['getDispenses', 'dispenser', 'INVALID_DISPENSER_INDEX'],
        ['getExecutions', 'contract', 'INVALID_CONTRACT_INDEX']
    ];

    it('refuses every malformed integer segment with its documented 400', function () {
        for(const [method, type, code] of CASES)
            for(const transport of ['api', 'explorer'])
                for(const value of BAD){
                    const { settled, st } = settle(transport, method, type, value);
                    expect(settled, method + ' ' + value).to.equal(true);
                    expect(st.response.code).to.equal(400);
                    expect(st.response.json.code).to.equal(code);
                    expect(st.response.json.error).to.be.a('string');
                }
    });

    it('passes a plain integer segment through to the read', function () {
        for(const [method, type] of CASES)
            for(const value of ['0', '7', '9007199254740991'])
                expect(settle('api', method, type, value).settled, method + ' ' + value).to.equal(false);
    });

    it('leaves text-keyed segments and the name search alone', function () {
        expect(settle('api', 'getGovernanceVotes', 'proposal', 'p-7junk').settled).to.equal(false);
        expect(settle('api', 'getCrossChainMatches', 'match', 'abc').settled).to.equal(false);
        expect(settle('api', 'getSearch', 'contract', 'counter').settled).to.equal(false);
    });

    it('passes an absent or literal null segment through as no filter, as list pages send it', function () {
        for(const [method, type] of CASES)
            for(const value of [null, undefined, '', 'null'])
                expect(settle('explorer', method, type, value).settled, method + ' ' + value).to.equal(false);
        expect(settle('explorer', 'getBlocks', 'block', 'null').settled).to.equal(false);
    });

    it('takes all as no filter on the blocks list only', function () {
        expect(settle('explorer', 'getBlocks', 'block', 'all').settled).to.equal(false);
        const { settled, st } = settle('api', 'getSends', 'block', 'all');
        expect(settled).to.equal(true);
        expect(st.response.json.code).to.equal('INVALID_BLOCK_INDEX');
    });

    it('leaves the block detail route to the reader, which refuses it for every caller', function () {
        expect(settle('api', 'getBlock', 'block', '9junk').settled).to.equal(false);
    });
});

describe('anchor lookup by path segment', function () {
    const Database = proxyquire('../../../../src/db/index.js', {
        './connection.js': proxyquire('../../../../src/db/connection.js', { mariadb: { createPool: () => ({}) } })
    });

    async function anchorBinds(search){
        const configInfo = createConfigInfoStub();
        const db = new Database({ configInfo, util: new Utility(configInfo) });
        const calls = [];
        db.doQuery = async (config, sql, args) => { calls.push({ sql: String(sql), args }); return []; };
        await db.getAnchor(makeConfig({ type: 'api', data: { method: 'getAnchor', search, type: 'anchor' } }));
        return calls.find((c) => /m\.action_index=\?|t2\.hash=\?/.test(c.sql));
    }

    it('reads a hex or exponent segment as a transaction hash, never as a number', async function () {
        for(const search of ['0x10', '1e3']){
            const call = await anchorBinds(search);
            expect(call.sql, search).to.include('t2.hash=?');
            expect(call.args[0], search).to.equal(search);
        }
    });

    it('reads plain digits as the action_index', async function () {
        const call = await anchorBinds('16');
        expect(call.sql).to.include('m.action_index=?');
        expect(call.args[0]).to.equal(16);
    });
});
