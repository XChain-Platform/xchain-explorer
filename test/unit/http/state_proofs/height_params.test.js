/********************************************************************
 *
 * Height query parameters on the state-proof routes.
 *
 * Express turns a repeated or bracketed query key (?height[]=5, ?height=5&height=6)
 * into an array. Every proof route must judge that value with the shared
 * utility, which refuses it, so a one-element array is never coerced into a
 * number and the same input gets the same answer on every proof route.
 *
 ********************************************************************/

'use strict';

const assert = require('assert');
const XChainExplorer = require('../../../../src/XChainExplorer.js');
const Utility = require('../../../../src/lib/utility.js');
const { getFullConfig } = require('../../../fixtures/mock-config.js');
const { segwit } = require('../../explorer/request/address_shape.test/support/address_encode.js');

const COIN = 'BTC';
const VALID_ADDRESS = segwit('bc', 0, Buffer.alloc(20, 0x22));

// Run one handler directly against a stubbed explorer, recording whether the proof server was reached
function run(handler, params, query, explorerConfig = {}) {
    const captured = { reachedServer: false };
    const res = {
        status(code) { captured.code = code; return this; },
        json(body) { captured.body = body; return this; }
    };
    const reached = async (...args) => {
        captured.reachedServer = true;
        captured.args = args;
        return { proof: {}, checkpoint: {} };
    };
    const self = {
        util: new Utility(),
        db: { pools: { [COIN]: {}, RBTC: {} } },
        mirrorGate: () => ({ blocked: null }),
        parseCoinCode: () => ({ coin: 'BTC', network: 'MAINNET' }),
        configInfo: { getConfig: async () => explorerConfig },
        proofServer: {
            balanceProof: reached, contractStateProof: reached,
            lockedBalanceProof: reached, validatorSetProof: reached
        }
    };
    const req = { params: Object.assign({ coin: COIN }, params), query: query || {} };
    return XChainExplorer.prototype[handler].call(self, req, res).then(() => captured);
}

const ARRAY_HEIGHTS = [['5'], ['5', '6'], '5,6'];
const ROUTES = [
    ['processContractStateProofRequest', { contractIndex: '7', key: 'k' }],
    ['processLockedBalanceProofRequest', { address: VALID_ADDRESS, tick: 'ABC' }],
    ['processValidatorSetProofRequest', {}]
];

describe('state-proof routes refuse an array-valued height', function () {
    for (const [handler, params] of ROUTES) {
        it(handler + ' answers 400 INVALID_HEIGHT and never reaches the proof server', async function () {
            for (const height of ARRAY_HEIGHTS) {
                const out = await run(handler, params, { height });
                assert.strictEqual(out.code, 400, JSON.stringify(height));
                assert.strictEqual(out.body.code, 'INVALID_HEIGHT');
                assert.strictEqual(out.reachedServer, false);
            }
        });
    }

    it('still accepts a plain decimal height on the contract-state route', async function () {
        const out = await run('processContractStateProofRequest', { contractIndex: '7', key: 'k' }, { height: '5' });
        assert.strictEqual(out.reachedServer, true);
    });
});

describe('balance-proof routes canonicalize address spelling before proof lookup', function () {
    const lower = segwit('bcrt', 0, Buffer.alloc(20, 0x11));
    const upper = lower.toUpperCase();
    const mixed = lower[0].toUpperCase() + lower.slice(1);

    for (const handler of ['processBalanceProofRequest', 'processLockedBalanceProofRequest']) {
        it(handler + ' passes uppercase bech32 to the proof server in canonical form', async function () {
            const out = await run(handler, { coin: 'RBTC', address: upper, tick: 'ABC' }, {}, getFullConfig());
            assert.strictEqual(out.reachedServer, true);
            assert.strictEqual(out.args[3], lower);
        });

        it(handler + ' rejects a mixed-case bech32 address', async function () {
            const out = await run(handler, { coin: 'RBTC', address: mixed, tick: 'ABC' }, {}, getFullConfig());
            assert.strictEqual(out.code, 400);
            assert.strictEqual(out.body.code, 'INVALID_ADDRESS');
            assert.strictEqual(out.reachedServer, false);
        });
    }
});
