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

const fs = require('fs');
const path = require('path');

const {
    sinon, expect, mockRes, eq, swq, stubCheckpointCommitment,
    makeExplorer, req, CP, PK, snapRow
} = require('./explorer_checkpoints.test/support/helpers.js');
const tipReaders = require('../../../src/db/readers/health/tip.js');
const IndexerConnector = require('../../../src/connectors/indexer.js');

const DIGEST = 'd4'.repeat(32);

async function verify(cp, supersessionRows, rules){
    const explorer = makeExplorer();
    explorer.db.getCheckpointRows.resolves([cp]);
    explorer.db.getCapabilitySnapshotRows.resolves([snapRow(PK('a'), 'src_a')]);
    explorer.db.getCheckpointSupersessionRows = sinon.stub().resolves(supersessionRows);
    explorer.db.getIndexerRules = sinon.stub().resolves(rules || null);
    const res = mockRes();
    await explorer.processCheckpointVerifyRequest(
        req({ coin: 'BTC', blockIndex: String(cp.block_index) }), res);
    return res;
}

function pinGates(){
    sinon.stub(eq, 'isEquivHeaderActive').returns(false);
    sinon.stub(swq, 'isStakeWeightedQuorumActive').returns(false);
    stubCheckpointCommitment().returns(false);
}

async function verifiesSupersedingCheckpoint(){
    const cp = { ...CP, checkpoint_seq: 8 };
    const metadata = {
        chain: cp.chain, network: cp.network, block_index: cp.block_index,
        checkpoint_seq: cp.checkpoint_seq, supersedes_from: 400, rules_digest: DIGEST
    };
    const res = await verify(cp, [metadata]);
    const base = ['XCHECKPOINT', cp.chain, cp.network, String(cp.block_index), cp.block_hash,
        cp.ledger_hash, cp.actions_hash, cp.contract_hash,
        String(cp.checkpoint_seq), String(cp.snapshot_block)].join('|');

    expect(res._status).to.equal(200);
    expect(res._body.canonical).to.equal(base + '|SUPERSEDE|400|' + DIGEST);
    expect(res._body.verified).to.equal(true);
    expect(res._body.checkpoint).to.include({ supersedes_from: 400, rules_digest: DIGEST });
    expect(res._body).to.include({ superseded_by_seq: null, supersedes_from: 400 });
}

async function reportsLowestSuperseder(){
    const current = {
        chain: CP.chain, network: CP.network, block_index: CP.block_index,
        checkpoint_seq: CP.checkpoint_seq, supersedes_from: null, rules_digest: null
    };
    const superseder = {
        chain: CP.chain, network: CP.network, block_index: 600,
        checkpoint_seq: 8, supersedes_from: 500, rules_digest: DIGEST
    };
    const res = await verify({ ...CP }, [current, superseder]);
    expect(res._body).to.include({ superseded_by_seq: 8, supersedes_from: null });
}

async function refusesFieldsBelowGate(){
    const cp = { ...CP, network: 'mainnet' };
    const metadata = {
        chain: cp.chain, network: cp.network, block_index: cp.block_index,
        checkpoint_seq: cp.checkpoint_seq, supersedes_from: 400, rules_digest: DIGEST
    };
    const res = await verify(cp, [metadata]);
    expect(res._body.canonical).to.not.include('|SUPERSEDE|');
    expect(res._body.verified).to.equal(false);
}

function plainMetadata(cp){
    return {
        chain: cp.chain, network: cp.network, block_index: cp.block_index,
        checkpoint_seq: cp.checkpoint_seq, supersedes_from: null, rules_digest: null
    };
}

async function withholdsOpenReplayFinality(){
    for(const blockIndex of [500, 501]){
        const cp = { ...CP, block_index: blockIndex };
        const res = await verify(cp, [plainMetadata(cp)], {
            digest: DIGEST,
            replay: { state: 'replaying', target: 500, replay_to: 550 }
        });
        expect(res._body.final, String(blockIndex)).to.equal(false);
    }
}

async function keepsPreReplayHeightFinal(){
    const cp = { ...CP, block_index: 499 };
    const res = await verify(cp, [plainMetadata(cp)], {
        digest: DIGEST,
        replay: { state: 'pending', target: 500, replay_to: 550 }
    });
    expect(res._body.final).to.equal(true);
}

async function readsScopedSupersessionRows(){
    const doQuery = sinon.stub().resolves([{
        checkpoint_seq: '8', block_index: '600', chain: 'BTC', network: 'regtest',
        supersedes_from: '500', rules_digest: DIGEST
    }]);
    const db = {
        checkpointSource: sinon.stub().returns({
            table: '`HubMirror`.state_checkpoints',
            filter: ' AND chain = ? AND network = ?',
            filterParams: ['BTC', 'regtest']
        }),
        doQuery
    };
    const rows = await tipReaders.getCheckpointSupersessionRows.call(db,
        { coin: 'BTC', data: {} }, { checkpoint_seq: 7, block_index: 500 });

    expect(doQuery.firstCall.args[1]).to.include('supersedes_from <= ?');
    expect(doQuery.firstCall.args[1]).to.include('AND chain = ? AND network = ?');
    expect(doQuery.firstCall.args[2]).to.deep.equal([7, 7, 500, 'BTC', 'regtest']);
    expect(rows[0]).to.include({
        checkpoint_seq: 8, block_index: 600,
        supersedes_from: 500, rules_digest: DIGEST
    });
}

async function readsIndexerRules(){
    const rules = {
        digest: DIGEST,
        replay: { state: 'pending', target: 500, replay_to: 550 }
    };
    sinon.stub(IndexerConnector, 'resolveIndexerUrl').returns('configured-indexer');
    sinon.stub(IndexerConnector.prototype, 'health').resolves({ rules });
    const db = { parseCoinCode: sinon.stub().resolves({ coin: 'BTC', network: 'regtest' }) };
    expect(await tipReaders.getIndexerRules.call(db, { coin: 'BTC', data: {} }))
        .to.deep.equal(rules);
}

function definesMirrorColumns(){
    const sql = fs.readFileSync(path.join(__dirname,
        '../../../src/sql/hub-mirror/state_checkpoints.sql'), 'utf8');
    expect(sql).to.match(/supersedes_from\s+BIGINT UNSIGNED/);
    expect(sql).to.match(/rules_digest\s+CHAR\(64\)/);
}

function checkpointSupersedeVerify(){
    beforeEach(pinGates);
    afterEach(function(){ sinon.restore(); });
    it('verifies a superseding checkpoint with both fields in the gated canonical', verifiesSupersedingCheckpoint);
    it('reports the lowest superseding sequence for an older row', reportsLowestSuperseder);
    it('refuses supersession fields below the activation gate', refusesFieldsBelowGate);
    it('serves the target and higher heights as not final while replay is open', withholdsOpenReplayFinality);
    it('keeps a height below an open replay target final', keepsPreReplayHeightFinal);
    it('reads current metadata and later superseders from the scoped mirror', readsScopedSupersessionRows);
    it('reads replay rules from the indexer health surface', readsIndexerRules);
    it('defines both supersession columns in the hub mirror schema', definesMirrorColumns);
}

describe('checkpoint supersede verify', checkpointSupersedeVerify);
