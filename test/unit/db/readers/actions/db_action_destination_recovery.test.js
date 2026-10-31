'use strict';

const sinon = require('sinon');
const { expect } = require('chai');
const Database = require('../../../../../src/db/index.js');
const Utility = require('../../../../../src/lib/utility.js');
const { getLogger } = require('../../../../../src/observability');

const RETRY_MS = 5 * 60 * 1000;
const cfg = { coin: 'RBTC' };
let clock;

function wrapped(code, errno) {
    const cause = Object.assign(new Error('driver said no'), { code, errno });
    return Object.assign(new Error('query failed'), { code: 'DB_ERROR', cause });
}

function mkDb(handler) {
    const db = Object.create(Database.prototype);
    db.util = new Utility();
    db.doQuery = sinon.stub().callsFake(async (config, query) => handler(config, query));
    return db;
}

function registerClockLifecycle() {
    beforeEach(() => {
        clock = sinon.useFakeTimers({ now: 1000000, toFake: ['Date'] });
    });

    afterEach(() => {
        clock.restore();
        sinon.restore();
    });
}

function registerRecoveryTest() {
    it('re-probes a missing bridge family and restores its credited address', async () => {
        let missing = true;
        const db = mkDb((config, query) => {
            if(query.includes('bridge_settlements m')) {
                if(missing) throw wrapped('ER_NO_SUCH_TABLE', 1146);
                return [{ action_index: 701n, destination: 'bridgeDest' }];
            }
            return [];
        });

        await db.getActionDestinationMap(cfg, [701n]);
        db.doQuery.resetHistory();
        await db.getActionDestinationMap(cfg, [701n]);
        expect(db.doQuery.firstCall.args[1]).to.not.include('bridge_settlements m');

        missing = false;
        clock.tick(RETRY_MS + 1);
        const recovered = await db.getActionDestinationMap(cfg, [701n]);
        expect(recovered.get('701')).to.deep.equal(['bridgeDest']);
        db.doQuery.resetHistory();
        await db.getActionDestinationMap(cfg, [701n]);
        expect(db.doQuery.firstCall.args[1]).to.include('bridge_settlements m');
    });
}

function registerMissingAfterDeadlineTest() {
    it('re-parks a family that is still missing after the deadline', async () => {
        const db = mkDb((config, query) => {
            if(query.includes('bridge_settlements m')) throw wrapped('ER_NO_SUCH_TABLE', 1146);
            return [];
        });

        await db.getActionDestinationMap(cfg, [701n]);
        clock.tick(RETRY_MS + 1);
        await db.getActionDestinationMap(cfg, [701n]);
        db.doQuery.resetHistory();
        await db.getActionDestinationMap(cfg, [701n]);

        expect(db.doQuery.firstCall.args[1]).to.not.include('bridge_settlements m');
    });
}

function registerTransitionLoggingTest() {
    it('logs disabled and enabled once per transition', async () => {
        const error = sinon.stub(getLogger(), 'error');
        const info = sinon.stub(getLogger(), 'info');
        let missing = true;
        const db = mkDb((config, query) => {
            if(query.includes('bridge_settlements m') && missing)
                throw wrapped('ER_NO_SUCH_TABLE', 1146);
            return query.includes('bridge_settlements m')
                ? [{ action_index: 701n, destination: 'bridgeDest' }] : [];
        });

        await db.getActionDestinationMap(cfg, [701n]);
        clock.tick(RETRY_MS + 1);
        await db.getActionDestinationMap(cfg, [701n]);
        clock.tick(RETRY_MS + 1);
        missing = false;
        await db.getActionDestinationMap(cfg, [701n]);

        expect(error.withArgs('ACTION_DESTINATIONS_FAMILY_DISABLED').callCount).to.equal(1);
        expect(info.withArgs('ACTION_DESTINATIONS_FAMILY_ENABLED').callCount).to.equal(1);
    });
}

function registerCoinIsolationTest() {
    it('keeps cooldown state isolated by coin', async () => {
        const db = mkDb((config, query) => {
            if(config.coin === 'RBTC' && query.includes('bridge_settlements m'))
                throw wrapped('ER_NO_SUCH_TABLE', 1146);
            return [];
        });

        await db.getActionDestinationMap(cfg, [701n]);
        db.doQuery.resetHistory();
        await db.getActionDestinationMap({ coin: 'RLTC' }, [701n]);

        expect(db.doQuery.firstCall.args[1]).to.include('bridge_settlements m');
    });
}

describe('action destination family cooldown', () => {
    registerClockLifecycle();
    registerRecoveryTest();
    registerMissingAfterDeadlineTest();
    registerTransitionLoggingTest();
    registerCoinIsolationTest();
});
