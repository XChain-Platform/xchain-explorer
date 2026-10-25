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
const { canonicalCheckpointString } = require('../../../src/explorer/proofs.js');

const DIGEST = 'd4'.repeat(32);

// The hub signs the checkpoint over StateCheckpointEngine's canonicalCheckpoint, whose
// one copy lives in the sibling hub's canonical_forms.js. The explorer re-types the same
// bytes in proofs.js, so the hub copy is the reference the verify route must match.
const HUB_CANONICAL_FORMS = process.env.XCHAIN_HUB_DIR
    ? path.join(process.env.XCHAIN_HUB_DIR, 'src', 'anchor', 'checkpoint_engine', 'canonical_forms.js')
    : path.join(__dirname, '..', '..', '..', '..', 'xchain-hub',
        'src', 'anchor', 'checkpoint_engine', 'canonical_forms.js');

// A regtest checkpoint carrying the light-client roots, so every flag the canonical
// reads (EQUIV wrap, root suffix, SUPERSEDE suffix) is live on both sides.
const ROOTED_CP = {
    ...CP, state_root: 'AB'.repeat(32), state_root_version: 1,
    block_merkle_root: 'CD'.repeat(32), block_merkle_version: 1
};
const SUPERSEDING_CP = {
    ...ROOTED_CP, checkpoint_seq: 8, supersedes_from: '400', rules_digest: DIGEST.toUpperCase()
};

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
    expect(res._body.canonical).to.equal(canonicalCheckpointString(
        { ...cp, supersedes_from: 400, rules_digest: DIGEST }));
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

    expect(doQuery.firstCall.args[1].replace(/\s+/g, ' ').trim()).to.equal(
        'SELECT checkpoint_seq, block_index, chain, network, supersedes_from, rules_digest ' +
        'FROM `HubMirror`.state_checkpoints ' +
        'WHERE 1 = 1 AND chain = ? AND network = ? ' +
        'AND (checkpoint_seq = ? OR ' +
        '(checkpoint_seq > ? AND supersedes_from IS NOT NULL AND supersedes_from <= ?)) ' +
        'ORDER BY checkpoint_seq ASC');
    expect(doQuery.firstCall.args[2]).to.deep.equal(['BTC', 'regtest', 7, 7, 500]);
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
    expect(sql).to.match(/supersedes_from\s+BIGINT UNSIGNED DEFAULT NULL/);
    expect(sql).to.match(/rules_digest\s+CHAR\(64\) DEFAULT NULL/);
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

function hubForms(){
    return require(HUB_CANONICAL_FORMS);
}

function requireHubSibling(){
    if(fs.existsSync(HUB_CANONICAL_FORMS)) return;
    if(process.env.XCHAIN_REQUIRE_SIBLINGS === '1')
        throw new Error('XCHAIN_REQUIRE_SIBLINGS=1 but the xchain-hub canonical forms are not at ' +
            HUB_CANONICAL_FORMS);
    this.skip();
}

function mirrorRow(cp){
    return {
        chain: cp.chain, network: cp.network, block_index: cp.block_index,
        checkpoint_seq: cp.checkpoint_seq,
        supersedes_from: cp.supersedes_from == null ? null : Number(cp.supersedes_from),
        rules_digest: cp.rules_digest == null ? null : cp.rules_digest
    };
}

function matchesHubForPlainCheckpoint(){
    const explorer = canonicalCheckpointString({ ...ROOTED_CP });
    expect(explorer).to.equal(hubForms().canonicalCheckpoint({ ...ROOTED_CP }));
    expect(explorer).to.not.include('SUPERSEDE');
}

function matchesHubForSupersedingCheckpoint(){
    const explorer = canonicalCheckpointString({ ...SUPERSEDING_CP });
    expect(explorer).to.equal(hubForms().canonicalCheckpoint({ ...SUPERSEDING_CP }));
    expect(explorer).to.include('|SUPERSEDE|400|' + DIGEST);
}

async function servesHubCanonicalFromVerifyRoute(){
    for(const cp of [ROOTED_CP, SUPERSEDING_CP]){
        const plain = { ...cp, supersedes_from: undefined, rules_digest: undefined };
        const res = await verify(plain, [mirrorRow(cp)]);
        expect(res._status, String(cp.checkpoint_seq)).to.equal(200);
        expect(res._body.canonical, String(cp.checkpoint_seq))
            .to.equal(hubForms().canonicalCheckpoint({ ...cp }));
    }
}

// Real flag-day gates on both sides: the hub reads its own registry and EQUIV header,
// so pinning only the explorer's copies would manufacture a mismatch.
function checkpointSupersedeHubBytes(){
    before(requireHubSibling);
    afterEach(function(){ sinon.restore(); });
    it('matches the hub canonical byte for byte for a plain checkpoint', matchesHubForPlainCheckpoint);
    it('matches the hub canonical byte for byte for a superseding checkpoint', matchesHubForSupersedingCheckpoint);
    it('serves the hub canonical from the verify route for plain and superseding rows', servesHubCanonicalFromVerifyRoute);
}

describe('checkpoint supersede canonical matches the hub @regression', checkpointSupersedeHubBytes);
