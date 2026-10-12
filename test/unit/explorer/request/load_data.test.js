'use strict';

const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();

const logError = sinon.stub();
const { loadData } = proxyquire('../../../../src/explorer/request/load_data.js', {
    '../../observability': { getLogger: () => ({ error: logError }) }
});

function makeState(){
    return {
        cfg: {
            coin: 'XCH',
            data: { path: '/blocks/42', query: { limit: '5' } }
        },
        response: { code: 200, json: null },
        data: null,
        total: null,
        dbError: false
    };
}

describe('loadData', function () {
    beforeEach(function () {
        logError.resetHistory();
    });

    it('stores the database rows and passes the resolved request config', async function () {
        const rows = [{ block_index: 42 }];
        const st = makeState();
        const getData = sinon.stub().resolves([rows, 1]);
        const explorer = { db: { getData } };

        await loadData(explorer, { path: '/blocks/42' }, st);

        expect(st.data).to.equal(rows);
        expect(st.total).to.equal(1);
        expect(getData.calledOnceWithExactly(st.cfg)).to.be.true;
        expect(st.dbError).to.be.false;
        expect(logError.called).to.be.false;
    });

    it('logs a rejected read and writes the database error response', async function () {
        const error = new Error('database unavailable');
        const st = makeState();
        const getData = sinon.stub().rejects(error);
        const explorer = { db: { getData } };

        await loadData(explorer, { path: '/blocks/42' }, st);

        expect(getData.calledOnceWithExactly(st.cfg)).to.be.true;
        expect(logError.calledOnceWithExactly('PROCESS_REQUEST_QUERY_FAILED', {
            path: '/blocks/42',
            err: error.message
        })).to.be.true;
        expect(st.dbError).to.be.true;
        expect(st.response).to.deep.equal({
            code: 500,
            json: {
                error: 'A database error occurred while serving this request.',
                code: 'DB_ERROR'
            }
        });
    });
});
