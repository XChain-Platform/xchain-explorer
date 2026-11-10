'use strict';

const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();

const logError = sinon.stub();
const { loadData } = proxyquire('../../../../src/explorer/request/load_data.js', {
    '../../observability': { getLogger: () => ({ error: logError }) }
});
const sourcesProto = require('../../../../src/db/readers/checkpoints/sources.js');

function makeState(){
    return {
        cfg: { coin: 'XCH', data: { path: '/governance_proposals/x/status', query: {} } },
        response: { code: 200, json: null },
        data: null, total: null, dbError: false
    };
}

// The real error a configured-but-unreachable hub produces on a cache miss.
function realOutageError(){
    const host = {
        explorer: { hubOperational: { staleMaxMs: 600000 } },
        util: { isNumeric: (v) => typeof v === 'number' }
    };
    try { sourcesProto.hubOperationalOutage.call(host, 'governance_proposals'); }
    catch(e){ return e; }
    throw new Error('hubOperationalOutage did not throw');
}

describe('loadData hub outage classification', function () {
    beforeEach(function () { logError.resetHistory(); });

    it('answers 503 HUB_UNAVAILABLE, not DB_ERROR, when the hub cannot be read', async function () {
        const st = makeState();
        const explorer = { db: { getData: sinon.stub().rejects(realOutageError()) } };
        await loadData(explorer, { path: '/x' }, st);
        expect(st.response.code).to.equal(503);
        expect(st.response.json.code).to.equal('HUB_UNAVAILABLE');
        expect(st.response.json.code).to.not.equal('DB_ERROR');
        expect(st.dbError).to.not.equal(true);
    });

    it('does not claim a stale ceiling for a key that was never cached', function () {
        const e = realOutageError();
        expect(e.message).to.not.match(/older than/);
        expect(e.message).to.include('governance_proposals');
    });

    it('keeps a generic error as 500 DB_ERROR', async function () {
        const st = makeState();
        const explorer = { db: { getData: sinon.stub().rejects(new Error('boom')) } };
        await loadData(explorer, { path: '/x' }, st);
        expect(st.response.code).to.equal(500);
        expect(st.response.json.code).to.equal('DB_ERROR');
        expect(st.dbError).to.equal(true);
    });
});
