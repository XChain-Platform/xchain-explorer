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
    sinon, expect, mockRes, makeExplorer, req, CP, PK, snapRow, stubCheckpointCommitment
} = require('../../../explorer/explorer_checkpoints.test/support/helpers.js');

const RULES_DIGEST = 'D4'.repeat(32);
const SDK_SUPERSESSION = process.env.XCHAIN_SDK_DIR
    ? path.join(process.env.XCHAIN_SDK_DIR,
        'src', 'protocol', 'light_client', 'checkpoint_supersession.js')
    : path.join(__dirname, '..', '..', '..', '..', '..', '..', 'xchain-sdk',
        'src', 'protocol', 'light_client', 'checkpoint_supersession.js');

function requireSdkSibling(){
    if(fs.existsSync(SDK_SUPERSESSION)) return;
    if(process.env.XCHAIN_REQUIRE_SIBLINGS === '1')
        throw new Error('XCHAIN_REQUIRE_SIBLINGS=1 but the xchain-sdk supersession reader is not at ' +
            SDK_SUPERSESSION);
    this.skip();
}

async function verifyResponse(){
    const cp = { ...CP, checkpoint_seq: 8 };
    const explorer = makeExplorer();
    explorer.db.getCheckpointRows.resolves([cp]);
    explorer.db.getCheckpointSupersessionRows = sinon.stub().resolves([{
        chain: cp.chain,
        network: cp.network,
        block_index: cp.block_index,
        checkpoint_seq: cp.checkpoint_seq,
        supersedes_from: 400,
        rules_digest: RULES_DIGEST
    }]);
    explorer.db.getCapabilitySnapshotRows.resolves([snapRow(PK('a'), 'src_a')]);
    const res = mockRes();
    await explorer.processCheckpointVerifyRequest(
        req({ coin: 'BTC', blockIndex: String(cp.block_index) }), res);
    return res;
}

describe('checkpoint verify rules digest field', function(){
    beforeEach(function(){ stubCheckpointCommitment().returns(false); });
    afterEach(function(){ sinon.restore(); });

    it('exposes the superseding checkpoint rules_digest at the response top level', async function(){
        const res = await verifyResponse();

        expect(res._status).to.equal(200);
        expect(res._body.checkpoint.rules_digest).to.equal(RULES_DIGEST);
        expect(res._body.rules_digest).to.equal(RULES_DIGEST.toLowerCase());
    });

    it('exposes rules_digest where the SDK supersessionFields reader consumes it', async function(){
        requireSdkSibling.call(this);
        const res = await verifyResponse();
        const { supersessionFields } = require(SDK_SUPERSESSION);

        expect(supersessionFields(res._body)).to.deep.equal({
            supersedes_from: 400,
            rules_digest: RULES_DIGEST.toLowerCase(),
            superseded_by_seq: null
        });
    });
});
