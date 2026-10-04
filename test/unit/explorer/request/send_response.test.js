'use strict';

const { expect } = require('chai');
const { sendResponse } = require('../../../../src/explorer/request/send_response.js');

function makeHarness(){
    const calls = { headers: {}, statuses: [], bodies: [], costs: [] };
    const explorer = {
        headers: { 'Cache-Control': 'no-store' },
        util: {
            getTimer: () => 37,
            getTimerString: milliseconds => `${milliseconds}ms`,
            isNull: value => value === null || value === undefined,
            jsonStringify: value => JSON.stringify(value)
        }
    };
    const req = { path: '/api/blocks/42' };
    const res = {
        set(name, value){
            if(typeof name === 'object')
                Object.assign(calls.headers, name);
            else
                calls.headers[name] = value;
        },
        status(code){
            calls.statuses.push(code);
        },
        send(body){
            calls.bodies.push(body);
        }
    };
    const st = {
        debugTimer: { started: true },
        cfg: { coin: 'XCH', type: 'api', file: 'blocks', data: {} },
        response: { code: 201, json: { block: 42 }, html: null, time: null }
    };
    const host = {
        configEnv: () => ({ DEBUG: false }),
        stats: { record: cost => calls.costs.push(cost), slow: () => {} }
    };
    return { calls, explorer, req, res, st, host };
}

describe('sendResponse', function () {
    it('writes the JSON response and records its cost once', function () {
        const { calls, explorer, req, res, st, host } = makeHarness();

        sendResponse(explorer, req, res, st, host);

        expect(calls.statuses).to.deep.equal([201]);
        expect(calls.headers).to.deep.equal({
            'Cache-Control': 'no-store',
            'Content-Type': 'application/json; charset=utf-8'
        });
        expect(calls.bodies).to.deep.equal(['{"block":42,"runtime":"37ms"}']);
        expect(calls.costs).to.deep.equal([37]);
    });

    it('applies freshness headers and metadata from the request state', function () {
        const { calls, explorer, req, res, st, host } = makeHarness();
        st.freshness = {
            stale: true,
            tip_block: 140,
            tip_age_seconds: 12,
            replica_halted: false
        };

        sendResponse(explorer, req, res, st, host);

        expect(calls.headers).to.include({
            'XChain-Freshness': 'stale',
            'XChain-Tip-Block': '140',
            'XChain-Tip-Age-S': '12'
        });
        expect(JSON.parse(calls.bodies[0]).freshness).to.deep.equal({
            stale: true,
            tip_block: 140,
            tip_age_seconds: 12,
            replica_halted: false
        });
        expect(calls.costs).to.deep.equal([37]);
    });
});
