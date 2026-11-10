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

// The whole pipeline: loadData -> assembleResponse -> applyFallbacks -> sendResponse, with only
// routing and parameter validation stubbed. loadData alone cannot see the not-found rewrite.
const { runRequest } = proxyquire('../../../../src/explorer/request/index.js', {
    './resolve_route.js': { resolveRoute: async (explorer, req, st) => {
        st.validDataRequest = true;
        st.cfg.type = 'api';
        st.cfg.coin = 'XCH';
        st.cfg.data.method = 'getGovernanceVote';
    } },
    './detail_record.js': { checkDetailRecord: async () => {} },
    './validate_params.js': { validateParams: () => false },
    './render_page.js': { renderPage: async () => {} },
    './load_data.js': { loadData },
    './send_response.js': proxyquire('../../../../src/explorer/request/send_response.js', {
        '../../observability': { getLogger: () => ({ error: logError, warn: () => {}, info: () => {} }) }
    })
});

function pipelineExplorer(getData){
    return {
        response: { code: 200, json: null, html: null, head: {} },
        headers: {},
        configInfo: { getConfig: async () => ({}) },
        db: { getData },
        urls: { html: {} },
        getPagingDataResults: (cfg, data) => data,
        util: {
            isNull: (v) => v === null || v === undefined,
            isNumeric: (v) => typeof v === 'number',
            startTimer: () => 0,
            getTimer: () => 1,
            getTimerString: () => '1ms',
            ksort: (o) => o,
            jsonStringify: (o) => JSON.stringify(o)
        }
    };
}

function fakeRes(){
    const res = { statusCode: null, body: null, headers: {} };
    res.set = (h, v) => { if(typeof h === 'string') res.headers[h] = v; else Object.assign(res.headers, h); return res; };
    res.status = (c) => { res.statusCode = c; return res; };
    res.send = (b) => { res.body = b; return res; };
    return res;
}

const host = { configEnv: () => ({}), stats: { record(){}, slow(){} } };

describe('full request pipeline on a hub outage', function () {
    it('answers 503 HUB_UNAVAILABLE, never the not-found 404', async function () {
        const explorer = pipelineExplorer(sinon.stub().rejects(realOutageError()));
        const res = fakeRes();
        await runRequest(explorer, { path: '/XCH/api/governance_votes/ab/voter', query: {}, ip: '1.2.3.4' }, res, host);
        expect(res.statusCode).to.equal(503);
        expect(JSON.parse(res.body).code).to.equal('HUB_UNAVAILABLE');
    });

    it('still answers 404 NOT_FOUND for a read that succeeded with no record', async function () {
        const explorer = pipelineExplorer(sinon.stub().resolves([null, null]));
        const res = fakeRes();
        await runRequest(explorer, { path: '/XCH/api/x', query: {}, ip: '1.2.3.4' }, res, host);
        expect(res.statusCode).to.equal(404);
        expect(JSON.parse(res.body).code).to.equal('NOT_FOUND');
    });

    it('keeps a DB failure as 500 DB_ERROR', async function () {
        const explorer = pipelineExplorer(sinon.stub().rejects(new Error('boom')));
        const res = fakeRes();
        await runRequest(explorer, { path: '/XCH/api/x', query: {}, ip: '1.2.3.4' }, res, host);
        expect(res.statusCode).to.equal(500);
        expect(JSON.parse(res.body).code).to.equal('DB_ERROR');
    });
});

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
