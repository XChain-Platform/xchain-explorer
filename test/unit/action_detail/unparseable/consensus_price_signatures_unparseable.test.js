'use strict';

const { expect } = require('chai');
const { PRICE } = require('../../../../src/action-detail/consensus');

describe('PRICE signature JSON parsing', function () {
    it('marks malformed signature JSON as unparseable', function () {
        const data = { sigs_json: '{bad json' };

        PRICE.afterMain({ action_index: 1 }, data);

        expect(data.signatures).to.deep.equal([]);
        expect(data.signatures_unparseable).to.equal(true);
    });

    it('does not mark valid signature JSON as unparseable', function () {
        const signatures = [{ pubkey: 'validator', signature: 'proof' }];
        const data = { sigs_json: JSON.stringify(signatures) };

        PRICE.afterMain({ action_index: 1 }, data);

        expect(data.signatures).to.deep.equal(signatures);
        expect(data.signatures_unparseable).to.not.be.ok;
    });

    it('leaves signatures absent when signature JSON is absent', function () {
        const data = {};

        PRICE.afterMain({ action_index: 1 }, data);

        expect(data.signatures).to.equal(undefined);
        expect(data.signatures_unparseable).to.not.be.ok;
    });
});
