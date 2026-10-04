'use strict';

const { expect } = require('chai');
const { validateParams } = require('../../../../src/explorer/request/validate_params.js');

function makeHarness(method, type, search, gate = { blocked: false }){
    let mirrorGateCalls = 0;
    const explorer = {
        util: { isSafeIntegerParam: value => Number.isSafeInteger(value) },
        mirrorGate: coin => {
            mirrorGateCalls++;
            expect(coin).to.equal('XCH');
            return gate;
        }
    };
    const st = {
        cfg: { coin: 'XCH', data: { method, type, search } },
        response: {}
    };
    return { explorer, st, mirrorGateCalls: () => mirrorGateCalls };
}

describe('validateParams', function () {
    it('rejects an unsafe action index', function () {
        const { explorer, st } = makeHarness('getAction', 'action_index', '7junk');

        expect(validateParams(explorer, st)).to.be.true;
        expect(st.badParam).to.be.true;
        expect(st.response.code).to.equal(400);
        expect(st.response.json).to.deep.equal({
            error: 'Invalid action_index',
            code: 'INVALID_ACTION_INDEX'
        });
    });

    it('rejects an unsafe checkpoint block index', function () {
        const { explorer, st } = makeHarness('getCheckpoint', 'block', 'junk');

        expect(validateParams(explorer, st)).to.be.true;
        expect(st.badParam).to.be.true;
        expect(st.response.code).to.equal(400);
        expect(st.response.json).to.deep.equal({
            error: 'Invalid block_index',
            code: 'INVALID_BLOCK_INDEX'
        });
    });

    it('allows safe action and checkpoint indexes', function () {
        const cases = [
            makeHarness('getAction', 'action_index', 7),
            makeHarness('getCheckpoint', 'block', 8)
        ];

        for(const { explorer, st } of cases)
            expect(validateParams(explorer, st)).to.be.false;
    });

    it('settles a cross-chain request when its mirror is blocked', function () {
        const gate = { blocked: true };
        const { explorer, st, mirrorGateCalls } =
            makeHarness('getCrossChainMatches', null, null, gate);

        expect(validateParams(explorer, st)).to.be.true;
        expect(st.data).to.deep.equal([]);
        expect(st.total).to.equal(0);
        expect(st.mirrorGate).to.equal(gate);
        expect(mirrorGateCalls()).to.equal(1);
    });

    it('allows a cross-chain request when its mirror is available', function () {
        const gate = { blocked: false };
        const { explorer, st, mirrorGateCalls } =
            makeHarness('getCrossChainMatches', null, null, gate);

        expect(validateParams(explorer, st)).to.be.false;
        expect(st.mirrorGate).to.equal(gate);
        expect(mirrorGateCalls()).to.equal(1);
    });

    it('does not check the mirror for another method', function () {
        const { explorer, st, mirrorGateCalls } = makeHarness('getBlocks', null, null);

        expect(validateParams(explorer, st)).to.be.false;
        expect(st.mirrorGate).to.be.null;
        expect(mirrorGateCalls()).to.equal(0);
    });

    it('settles short token and subtoken searches with an empty result', function () {
        const cases = [
            makeHarness('getTokens', 'token', undefined),
            makeHarness('getTokens', 'subtoken', '  ab ')
        ];

        for(const { explorer, st } of cases){
            expect(validateParams(explorer, st)).to.be.true;
            expect(st.data).to.deep.equal([]);
            expect(st.total).to.equal(0);
        }
    });

    it('allows long token searches and address searches', function () {
        const cases = [
            makeHarness('getTokens', 'token', 'abc'),
            makeHarness('getTokens', 'address', 'ab')
        ];

        for(const { explorer, st } of cases)
            expect(validateParams(explorer, st)).to.be.false;
    });
});
