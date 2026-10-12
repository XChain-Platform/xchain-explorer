'use strict';

const assert = require('assert');

const { resetForMove } = require('../../../../../src/hub/hub_db_sync/failover/move_reset');

describe('hub sync move reset', function () {
    it('resets move state without changing unrelated fields', function () {
        const originalDrainPositions = { blocks: 42 };
        const sync = {
            _drainPositions: originalDrainPositions,
            _lastHubInstanceId: 'hub-2',
            _readyMaxIds: { blocks: 18 },
            _readyWatermark: 17,
            _readyHeights: { bitcoin: 250 },
            priceSyncMaxTimestamp: 123456,
            oracleSyncTimestamp: 123400,
            unrelated: { preserved: true }
        };
        const originalKeys = Object.keys(sync).sort();
        const unrelated = sync.unrelated;

        const result = resetForMove(sync);

        assert.strictEqual(result, undefined);
        assert.notStrictEqual(sync._drainPositions, originalDrainPositions);
        assert.strictEqual(Object.getPrototypeOf(sync._drainPositions), null);
        assert.deepStrictEqual(Object.keys(sync._drainPositions), []);
        assert.strictEqual(sync._lastHubInstanceId, null);
        assert.strictEqual(sync._readyMaxIds, undefined);
        assert.strictEqual(sync._readyWatermark, null);
        assert.strictEqual(sync._readyHeights, null);
        assert.strictEqual(sync.priceSyncMaxTimestamp, 0);
        assert.strictEqual(sync.oracleSyncTimestamp, null);
        assert.strictEqual(sync.unrelated, unrelated);
        assert.deepStrictEqual(Object.keys(sync).sort(), originalKeys);
    });

    it('allocates a new drain position map on every call', function () {
        const sync = {};

        resetForMove(sync);
        const firstDrainPositions = sync._drainPositions;
        resetForMove(sync);

        assert.notStrictEqual(sync._drainPositions, firstDrainPositions);
        assert.strictEqual(Object.getPrototypeOf(sync._drainPositions), null);
        assert.deepStrictEqual(Object.keys(sync._drainPositions), []);
    });
});
