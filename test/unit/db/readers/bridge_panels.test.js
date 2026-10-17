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
 ********************************************************************/

'use strict';

const { expect } = require('chai');
const readers = require('../../../../src/db/readers/checkpoints/bridge_panels.js');

function harness(rows){
    const calls = [];
    return {
        calls,
        db: {
            async doQuery(config, sql, args){
                calls.push({ config, sql, args });
                return rows;
            }
        }
    };
}

describe('bridge panel database readers', function(){
    it('binds, chain-filters, orders, and caps the bridge transfer read', async function(){
        const h = harness([{ transfer_id: 'a'.repeat(64) }]);
        const config = {
            coin: 'TDOGE', schema: 'hub_mirror', network: 'testnet',
            chain: 'DOGE', tick: 'FUFU', copyTick: 'BTC.FUFU', limit: 900
        };

        const rows = await readers.getBridgeTransfers.call(h.db, config);

        expect(rows).to.deep.equal([{ transfer_id: 'a'.repeat(64) }]);
        expect(h.calls).to.have.lengthOf(1);
        expect(h.calls[0].sql).to.include('FROM `hub_mirror`.bridge_transfers b');
        expect(h.calls[0].sql).to.match(/WHERE b\.tick IN \(\?, \?\) AND b\.network = \?/);
        expect(h.calls[0].sql).to.match(/b\.src_chain = \? OR b\.dest_chain = \?/);
        expect(h.calls[0].sql).to.match(/ORDER BY b\.id DESC\s+LIMIT \?/);
        expect(h.calls[0].args).to.deep.equal(['FUFU', 'BTC.FUFU', 'testnet', 'DOGE', 'DOGE', 100]);
    });

    it('reads only the latest locally applied policy with indexed predicates', async function(){
        const row = { policy_seq: '7', policy_hash: 'b'.repeat(64) };
        const h = harness([row]);
        const config = {
            coin: 'DOGE', schema: 'hub_mirror', network: 'mainnet',
            origin: 'BTC', tick: 'FUFU', copyTick: 'BTC.FUFU'
        };

        const applied = await readers.getAppliedPolicy.call(h.db, config);

        expect(applied).to.equal(row);
        expect(h.calls).to.have.lengthOf(1);
        expect(h.calls[0].sql).to.include('FROM `hub_mirror`.policy_snapshots p');
        expect(h.calls[0].sql).to.match(/p\.network = \? AND p\.origin_chain = \? AND p\.tick = \?/);
        expect(h.calls[0].sql).to.match(/s\.transfer_id = p\.snapshot_id AND s\.kind = \?/);
        expect(h.calls[0].sql).to.match(/ORDER BY p\.policy_seq DESC\s+LIMIT 1/);
        expect(h.calls[0].args).to.deep.equal([
            'BTC.FUFU', 'mainnet', 'BTC', 'FUFU', 'finalized', 'policy'
        ]);
    });

    it('rejects an unsafe mirror identifier before issuing SQL', async function(){
        const h = harness([]);
        const config = {
            coin: 'DOGE', schema: 'hub_mirror;DROP', network: 'mainnet',
            origin: 'BTC', tick: 'FUFU', copyTick: 'BTC.FUFU'
        };

        let error = null;
        try { await readers.getAppliedPolicy.call(h.db, config); } catch(err){ error = err; }

        expect(error).to.be.an('error').with.property('message', 'Invalid bridge mirror schema');
        expect(h.calls).to.deep.equal([]);
    });
});
