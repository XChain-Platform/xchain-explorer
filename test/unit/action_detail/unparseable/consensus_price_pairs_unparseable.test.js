'use strict';

const assert = require('assert');
const { PRICE } = require('../../../../src/action-detail/consensus.js');

describe('PRICE action detail pairs parsing', function () {
    it('marks malformed pairs JSON as unparseable', function () {
        const data = { pairs_json: '{malformed' };

        PRICE.afterMain({ action_index: 1 }, data);

        assert.deepStrictEqual(data.pairs, []);
        assert.strictEqual(data.pairs_unparseable, true);
    });

    it('does not mark a valid pairs array as unparseable', function () {
        const pairs = [{ pair: 'BTC/USD', price: 65000 }];
        const data = { pairs_json: JSON.stringify(pairs) };

        PRICE.afterMain({ action_index: 1 }, data);

        assert.deepStrictEqual(data.pairs, pairs);
        assert.ok(!data.pairs_unparseable);
    });

    it('leaves pairs undefined when pairs JSON is absent', function () {
        const data = {};

        PRICE.afterMain({ action_index: 1 }, data);

        assert.strictEqual(data.pairs, undefined);
        assert.ok(!data.pairs_unparseable);
    });
});
