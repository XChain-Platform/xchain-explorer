/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 ********************************************************************/

'use strict';

const { expect } = require('chai');
const proxyquire = require('proxyquire');
const sinon = require('sinon');
const Utility = require('../../../src/lib/utility.js');
const { createConfigInfoStub } = require('../../fixtures/mock-config.js');
const misc = require('../../../src/action-detail/misc.js');
const sql = require('../../../src/db/action_detail/misc_sql.js');
const sharedSql = require('../../../src/db/action_detail/shared_sql.js');
const multipart = require('../../../src/db/readers/entities/files_multipart.js');
const lookupMethods = require('../../../src/db/readers/entities/lookups.js');

const Database = proxyquire('../../../src/db/index.js', {
    './connection.js': proxyquire('../../../src/db/connection.js', { mariadb: { createPool: () => ({}) } })
});

const config = { coin: 'RBTC' };

function manifest(partCount, result){
    return {
        kind: 'manifest',
        file_hash: 'ab'.repeat(32),
        total_parts: partCount,
        parts_received: partCount - 1,
        total_bytes: partCount * 100,
        completion_result: result,
        parts: Array.from({ length: partCount - 1 }, (_, part_index) => ({ part_index }))
    };
}

function partRow(overrides = {}){
    return Object.assign({
        action_index: 81,
        source: 'bcrt1qsource',
        tx_hash: 'cd'.repeat(32),
        block_index: 900,
        status: 'valid',
        file_hash: 'ef'.repeat(32),
        part_index: '3',
        manifest_action_index: null
    }, overrides);
}

function productionDb(row){
    const configInfo = createConfigInfoStub();
    const db = new Database({ configInfo, util: new Utility(configInfo) });
    db.getActionType = sinon.stub().resolves('FILE');
    db.attachActionDetailSupplements = sinon.stub().resolves();
    db.getActionFeeData = sinon.stub().resolves(null);
    db.getTransactionData = sinon.stub().resolves({ data: null });
    db.doQuery = sinon.stub().callsFake(async (cfg, statement) => {
        if(statement === sql.FILE_QUERY) return [];
        if(statement === sharedSql.ACTION_BASELINE) return [{
            action: 'FILE', action_format: 2, action_index: 81,
            source: 'baseline-source', tx_hash: 'baseline-hash',
            block_index: 900, timestamp: 123
        }];
        if(statement === sql.FILE_PART_QUERY) return [row];
        return [];
    });
    return db;
}

describe('FILE multipart format declaration', function(){
    it('declares formats 1 and 2 as rendered', function(){
        expect(misc.FILE.renderedFormats).to.deep.equal([0, 1, 2]);
        expect(misc.FILE.unrenderedFormats).to.deep.equal({});
    });
});

describe('FILE part detail read', function(){
    it('uses one bound query and returns its row', async function(){
        const row = partRow();
        const db = { doQuery: sinon.stub().resolves([row]) };
        expect(await multipart.readFilePartDetail(db, config, 81)).to.equal(row);
        sinon.assert.calledOnceWithExactly(db.doQuery, config, sql.FILE_PART_QUERY, [81]);
        expect(sql.FILE_PART_QUERY).to.include('WHERE\n                    fp.action_index=?');
        expect(sql.FILE_PART_QUERY).to.not.include('81');
        expect(sql.FILE_PART_QUERY).to.include("ms.status='valid'");
    });

    it('returns null when the index has no file_parts row', async function(){
        const db = { doQuery: sinon.stub().resolves([]) };
        expect(await multipart.readFilePartDetail(db, config, 82)).to.equal(null);
        expect(db.doQuery.callCount).to.equal(1);
    });
});

describe('FILE part action detail', function(){
    it('resolves a part without a files row and exposes its verdict', async function(){
        const row = partRow();
        const data = { action: 'FILE', action_format: 2, timestamp: 123 };
        const db = { doQuery: sinon.stub().resolves([row]) };
        await misc.FILE.afterQueries({ db, config, action_index: 81 }, data);
        expect(data).to.include({
            action: 'FILE', action_format: 2, action_index: 81,
            source: row.source, tx_hash: row.tx_hash, block: 900, status: 'valid'
        });
        expect(data.block_index).to.equal(900);
        expect(data.file_part).to.deep.equal({
            file_hash: row.file_hash, part_index: 3, manifest_action_index: null
        });
        expect(data.timestamp).to.equal(123);
        sinon.assert.calledOnceWithExactly(db.doQuery, config, sql.FILE_PART_QUERY, [81]);
    });

    it('keeps a valid manifest index including zero', async function(){
        for(const manifest_action_index of [0, 70]){
            const data = { action_format: 2 };
            const db = { doQuery: sinon.stub().resolves([partRow({ manifest_action_index })]) };
            await misc.FILE.afterQueries({ db, config, action_index: 81 }, data);
            expect(data.file_part.manifest_action_index).to.equal(manifest_action_index);
        }
    });
});

describe('FILE part production action detail fallback', function(){
    it('resolves file_parts after FILE_QUERY returns no files row', async function(){
        const row = partRow();
        const db = productionDb(row);

        const data = await db.getActionData(config, 81);

        expect(data).to.include({
            action: 'FILE', action_format: 2, action_index: 81,
            source: row.source, tx_hash: row.tx_hash, block: 900, status: 'valid'
        });
        expect(data.block_index).to.equal(900);
        expect(data.file_part).to.deep.equal({
            file_hash: row.file_hash, part_index: 3, manifest_action_index: null
        });
        sinon.assert.calledWithExactly(db.doQuery, config, sql.FILE_QUERY, [81]);
        sinon.assert.calledWithExactly(db.doQuery, config, sharedSql.ACTION_BASELINE, [81]);
        sinon.assert.calledWithExactly(db.doQuery, config, sql.FILE_PART_QUERY, [81]);
    });
});

describe('FILE manifest metadata summary read', function(){
    it('keeps metadata-only read count constant at 4 and 4,096 parts', async function(){
        for(const partCount of [4, 4096]){
            const row = {
                manifest_action_index: 50,
                manifest_status: 'valid',
                part_exists: 0,
                file_hash: 'ab'.repeat(32),
                total_parts: partCount,
                total_bytes: partCount * 100,
                name: 'file.bin',
                type: 'application/octet-stream',
                gated: 0,
                completion_result: null,
                manifest_tx_hash: 'cd'.repeat(32),
                parts_received: partCount - 1,
                position: null
            };
            const db = {
                util: { isNull: value => value === null || value === undefined },
                doQuery: sinon.stub().resolves([row])
            };
            const result = await lookupMethods.getMultipartFileRaw.call(db, config, 50, { metadataOnly: true });
            expect(result.parts_received).to.equal(partCount - 1);
            expect(result.parts).to.deep.equal([]);
            expect(db.doQuery.callCount).to.equal(1);
            expect(db.doQuery.firstCall.args[1]).to.include('SELECT COUNT(*) FROM file_parts counted_part');
            expect(db.doQuery.firstCall.args[1]).to.not.include('LEFT JOIN file_parts fp ON');
        }
    });
});

describe('FILE manifest multipart summary', function(){
    it('uses one bulk metadata read for both 2 and 26 parts', async function(){
        for(const partCount of [2, 26]){
            const data = { action: 'FILE', action_format: 1 };
            const db = { getMultipartFileRaw: sinon.stub().resolves(manifest(partCount, null)) };
            await misc.FILE.afterQueries({ db, config, action_index: 50 }, data);
            expect(db.getMultipartFileRaw.callCount).to.equal(1);
            sinon.assert.calledWithExactly(db.getMultipartFileRaw, config, 50, { metadataOnly: true });
            expect(data.multipart).to.include({
                total_parts: partCount, parts_received: partCount - 1,
                total_bytes: partCount * 100, status: 'pending'
            });
            expect(data.detail_incomplete).to.equal(true);
            expect(Object.keys(data)).to.not.include('detail_incomplete');
        }
    });

    it('maps both terminal completion results', async function(){
        for(const status of ['complete', 'mismatch']){
            const data = { action_format: '1' };
            const db = { getMultipartFileRaw: sinon.stub().resolves(manifest(2, status)) };
            await misc.FILE.afterQueries({ db, config, action_index: 50 }, data);
            expect(data.multipart.status).to.equal(status);
            expect(data).to.not.have.property('detail_incomplete');
        }
    });

    it('does no multipart read for format zero', async function(){
        const data = { action_format: 0 };
        const db = { getMultipartFileRaw: sinon.stub(), doQuery: sinon.stub() };
        await misc.FILE.afterQueries({ db, config, action_index: 50 }, data);
        sinon.assert.notCalled(db.getMultipartFileRaw);
        sinon.assert.notCalled(db.doQuery);
    });
});

describe('file part block action counts', function(){
    it('uses one bulk read for both 2 and 26 blocks', async function(){
        for(const count of [2, 26]){
            const blocks = Array.from({ length: count }, (_, block_index) => ({
                block_index, actions: { files: 1 }
            }));
            const db = { doQuery: sinon.stub().resolves([{ block_index: 0, count: '2' }]) };
            await multipart.attachFilePartBlockCounts(db, config, blocks);
            expect(db.doQuery.callCount).to.equal(1);
            expect(db.doQuery.firstCall.args[2]).to.deep.equal(blocks.map(row => row.block_index));
            expect(blocks[0].actions.files).to.equal(3);
            expect(blocks[1].actions.files).to.equal(1);
        }
    });

    it('merges part-only counts into the public files family', function(){
        const blocks = [
            { block_index: 10, actions: {} },
            { block_index: 11, actions: { files: 3 } }
        ];
        multipart.mergeFilePartCounts(blocks, [
            { block_index: 10, count: '4' },
            { block_index: 11, count: '2' },
            { block_index: 99, count: '9' }
        ]);
        expect(blocks).to.deep.equal([
            { block_index: 10, actions: { files: 4 } },
            { block_index: 11, actions: { files: 5 } }
        ]);
    });
});
