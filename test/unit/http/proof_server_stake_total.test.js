'use strict';

// The proof server authors the validator-set total from the stake snapshot. The
// producers commit the exact BigInt sum (M.sumCanonicalAmounts); this path once
// went through String(bignumber), which is exponent notation from 1e21 up, so a
// valid snapshot was refused as STAKE_SNAPSHOT_MALFORMED.

const assert = require('assert');
const M = require('../../../src/consensus/merkle.js');
const { NET, S, CAP, makeValidatorSetServer } = require('./proof_server.test/support/helpers.js');

function connFor(vals) {
    return { async stakeWeights(cap) {
        return (cap === CAP) ? { capability: cap, block_index: S, validators: vals, truncated: false }
                             : { error: 'capability not configured: ' + cap };
    } };
}
function set(a, b, c) {
    return [{ pubkey: 'aa'.repeat(32), source: 'S1', weight: a },
            { pubkey: 'bb'.repeat(32), source: 'S1', weight: a },     // same source, counted once
            { pubkey: 'cc'.repeat(32), source: 'S2', weight: b },
            { pubkey: 'dd'.repeat(32), source: 'S3', weight: c }];
}

describe('ProofServer.validatorSetProof total matches the producer commitment', function () {
    const cases = [
        ['existing small totals are unchanged', ['10', '30', '0.5'], '40.5'],
        ['a total of exactly 1e21', ['600000000000000000000', '300000000000000000000', '100000000000000000000'], '1000000000000000000000'],
        ['a total above 1e21 with decimals', ['600000000000000000000.12345678', '400000000000000000000.5', '1.00000001'], null],
        ['a 30-digit total', ['123456789012345678901234567890', '100000000000000000000000000000', '1.5'], null]
    ];
    for (const [name, [a, b, c], expectInt] of cases) {
        it(name, async function () {
            const vals = set(a, b, c);
            const producer = M.sumCanonicalAmounts([a, b, c]);          // indexer stakes_root.js path
            if (expectInt) assert.strictEqual(producer, M.canonicalAmount(expectInt));
            const { server } = makeValidatorSetServer();
            const r = await server.validatorSetProof({ coin: 'RBTC' }, 'BTC', NET, S, connFor(vals));
            assert.ok(!r.error, 'no error: ' + r.error);
            assert.strictEqual(r.proof.capabilities[CAP].total, producer);
        });
    }

    it('still fails closed on a blank source', async function () {
        const vals = set('10', '30', '5'); vals[2].source = '';
        const { server } = makeValidatorSetServer();
        const r = await server.validatorSetProof({ coin: 'RBTC' }, 'BTC', NET, S, connFor(vals));
        assert.ok(/^STAKE_SNAPSHOT_MALFORMED:/.test(r.error), String(r.error));
    });
});
