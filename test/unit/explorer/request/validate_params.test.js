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

describe('validateParams integer searches', function () {
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
});

describe('validateParams slash proposal filters', function () {
    const HEX64 = 'ab'.repeat(32);

    it('refuses a malformed status or pubkey with a registered 400', function () {
        const cases = [
            ['status', 'bogus', 'INVALID_SLASH_STATUS'],
            ['status', '-1', 'INVALID_SLASH_STATUS'],
            ['status', '1e309', 'INVALID_SLASH_STATUS'],
            ['status', 'pending\u0000', 'INVALID_SLASH_STATUS'],
            ['status', 'x'.repeat(10240), 'INVALID_SLASH_STATUS'],
            ['status', 'PENDING', 'INVALID_SLASH_STATUS'],
            ['pubkey', 'abcd', 'INVALID_SLASH_PUBKEY'],
            ['pubkey', 'AB'.repeat(33), 'INVALID_SLASH_PUBKEY'],
            ['pubkey', 'zz'.repeat(32), 'INVALID_SLASH_PUBKEY']
        ];

        for(const [type, search, code] of cases){
            const { explorer, st } = makeHarness('getSlashProposals', type, search);
            expect(validateParams(explorer, st), type + ' ' + search.slice(0, 12)).to.be.true;
            expect(st.badParam).to.be.true;
            expect(st.response.code).to.equal(400);
            expect(st.response.json.code).to.equal(code);
            expect(st.data).to.equal(undefined);
        }
    });

    it('lets valid filters and the unfiltered list through to the read', function () {
        const cases = [
            ['status', 'pending'], ['status', 'approved'], ['status', 'rejected'],
            ['status', 'expired'], ['pubkey', HEX64], ['pubkey', HEX64.toUpperCase()],
            [null, undefined], ['status', 'null']
        ];

        for(const [type, search] of cases){
            const { explorer, st } = makeHarness('getSlashProposals', type, search);
            expect(validateParams(explorer, st), type + ' ' + search).to.be.false;
            expect(st.badParam).to.equal(undefined);
        }
    });

    it('does not apply the filter rules to another method', function () {
        const { explorer, st } = makeHarness('getVotes', 'status', 'bogus');

        expect(validateParams(explorer, st)).to.be.false;
    });
});

describe('validateParams mirror and token searches', function () {
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
