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
 * Drift guard: the getContract reader and the body sent by the HTTP
 * response path must expose exactly the fields published by Contract.
 *********************************************************************/

'use strict';

const crypto     = require('crypto');
const proxyquire = require('proxyquire');
const { expect } = require('chai');
const Utility    = require('../../../src/lib/utility.js');
const { sendResponse } = require('../../../src/explorer/request/send_response.js');
const { createConfigInfoStub } = require('../../fixtures/mock-config.js');
const { makeConfig }           = require('../../fixtures/mock-query-args.js');
const SCHEMAS = require('../../../docs/openapi.schemas.js');

const Database = proxyquire('../../../src/db/index.js', {
    './connection.js': proxyquire('../../../src/db/connection.js', { mariadb: { createPool: () => ({}) } })
});

describe('openapi getContract body', function () {
    it('publishes exactly the keys the reader serves', async function () {
        const configInfo = createConfigInfoStub();
        const util = new Utility(configInfo);
        const db = new Database({ configInfo, util });
        const code = 'module.exports = { ping: function(xchain){} };';
        const config = makeConfig({ coin: 'BTC', data: {
            method: 'getContract', search: '900', type: 'contract',
            sql: { where: { data: 'm.action_index=?', offset: '' }, order: 'DESC', limit: 1 }
        } });

        db.doQuery = async (_config, query) => {
            if(query.includes('SELECT input_params FROM contract_executions'))
                return [{ input_params: 'hello' }];
            return [{
                action: 'DEPLOY', action_index: BigInt(900), action_format: 1, source: 'source-address',
                code, code_hash: crypto.createHash('sha256').update(code).digest('hex'), api_version: 1,
                cooldown_blocks: null, slash_destination: null, meta_name: 'Example',
                meta_description: 'Contract description', meta_version: '1.0.0',
                meta_json: '{"name":"Example"}', block_index: BigInt(500), timestamp: BigInt(1700000000),
                tx_hash: 'transaction-hash', tx_index: BigInt(90), status: 'valid',
                permissions: '["send"]', max_take_bps: 300,
            }];
        };

        const [body] = await db.getContract(config);
        let sent;
        sendResponse({ headers: {}, util }, { path: '/BTC/api/contract/900' }, {
            set() {}, status() {}, send(value) { sent = value; }
        }, {
            debugTimer: Date.now(), cfg: config,
            response: { code: 200, json: body, html: null, time: null }
        }, {
            configEnv: () => ({ DEBUG: false }),
            stats: { record() {}, slow() {} }
        });

        const served = JSON.parse(sent);
        expect(served).to.not.have.property('meta_json');
        expect(Object.keys(served).sort()).to.deep.equal(
            Object.keys(SCHEMAS.COMPONENT_SCHEMAS.Contract.properties).sort());
    });
});
