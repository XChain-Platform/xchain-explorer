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
 *
 * Regression coverage for pure checkpoint supersession response fields.
 *
 ********************************************************************/

'use strict';

const { expect } = require('chai');
const {
    supersededBySeq,
    supersessionBody
} = require('../../../src/explorer/checkpoint_supersession.js');

function row(checkpointSeq, blockIndex, supersedesFrom, chain = 'LTC', network = 'testnet'){
    return {
        chain,
        network,
        checkpoint_seq: checkpointSeq,
        block_index: blockIndex,
        supersedes_from: supersedesFrom === undefined ? null : supersedesFrom
    };
}

function testsBoundaryPosition(){
    const superseder = row(12, 120, 105);

    expect(supersededBySeq(row(10, 104), [superseder])).to.equal(null);
    expect(supersededBySeq(row(10, 105), [superseder])).to.equal(12);
    expect(supersededBySeq(row(11, 110), [superseder])).to.equal(12);
}

function testsLowestSuperseder(){
    const subject = row(10, 110);

    expect(supersededBySeq(subject, [row(13, 130, 100), row(12, 120, 105)]))
        .to.equal(12);
}

function testsCheckpointIdentity(){
    const subject = row(10, 110);
    const candidates = [
        row(11, 120, 100, 'DOGE'),
        row(12, 120, 100, 'LTC', 'mainnet'),
        row(9, 120, 100)
    ];

    expect(supersededBySeq(subject, candidates)).to.equal(null);
}

function testsNumericDriverStrings(){
    const subject = row('11', '110');

    expect(supersededBySeq(subject, [row('12', '120', '105')])).to.equal(12);
}

function supersededCheckpointSequenceRules(){
    it('supersedes rows at and above its supersedes_from boundary, but not below it',
        testsBoundaryPosition);
    it('returns the lowest sequence of multiple qualifying superseders', testsLowestSuperseder);
    it('ignores another chain, another network, and lower checkpoint sequences',
        testsCheckpointIdentity);
    it('compares and returns numeric driver strings as numbers', testsNumericDriverStrings);
}

function testsExactBodyFields(){
    const subject = row(11, 110);
    const body = supersessionBody(subject, [row(12, 120, 105)]);

    expect(Object.keys(body).sort()).to.deep.equal(['superseded_by_seq', 'supersedes_from']);
    expect(body).to.deep.equal({ superseded_by_seq: 12, supersedes_from: null });
    expect(supersessionBody(row('12', '120', '105'), [])).to.deep.equal({
        superseded_by_seq: null,
        supersedes_from: 105
    });
}

function testsPlainRow(){
    const subject = { chain: 'LTC', network: 'testnet', checkpoint_seq: 1, block_index: 1 };

    expect(supersessionBody(subject, [])).to.deep.equal({
        superseded_by_seq: null,
        supersedes_from: null
    });
}

function testsUnmutatedInputs(){
    const subject = row('11', '110');
    const rows = [subject, row('12', '120', '105')];
    const before = JSON.stringify({ subject, rows });

    supersessionBody(subject, rows);

    expect(JSON.stringify({ subject, rows })).to.equal(before);
}

function checkpointSupersessionBodyFields(){
    it('returns exactly superseded_by_seq and supersedes_from from supersessionBody',
        testsExactBodyFields);
    it('answers both fields null for a plain row', testsPlainRow);
    it('does not mutate the row or rows', testsUnmutatedInputs);
}

describe('@regression superseded checkpoint sequence rules', supersededCheckpointSequenceRules);
describe('@regression checkpoint supersession body fields', checkpointSupersessionBodyFields);
