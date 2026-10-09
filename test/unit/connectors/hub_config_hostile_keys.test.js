'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// A getallconfigs delta is remote JSON, so a "__proto__" or "constructor" key in
// it must never reach Object.prototype or a built-in through the cached tree.

const { expect, makeAxiosStub, loadConnector } = require('./hub_connector.test/support/helpers.js');

const MARK = 'pollutedByHubTest';

function scrubMarkers() {
    delete Object.prototype[MARK];
    delete Object[MARK];
    delete Object.prototype.toString[MARK];
}

function mergeDelta(json) {
    const Connector = loadConnector(makeAxiosStub());
    const c = new Connector(['http://localhost:3000']);
    c.configs = { BTC: { mainnet: { fees: { a: '1' } } } };
    c.lastWatermark = 1000;
    return c.applyConfigResult({ configs: JSON.parse(json), seq: 2, watermark: 2000 });
}

describe('applyConfigResult() hostile delta keys', function () {
    afterEach(scrubMarkers);

    it('ignores __proto__ and constructor keys and keeps the legitimate rows', function () {
        const out = mergeDelta('{"__proto__":{"' + MARK + '":{"m":{"p":1}}},' +
            '"constructor":{"' + MARK + '":{"m":{"p":1}}},' +
            '"BTC":{"mainnet":{"fees":{"b":"2"},"__proto__":{"' + MARK + '":1}}}}');
        expect(({})[MARK]).to.equal(undefined);
        expect(Object[MARK]).to.equal(undefined);
        expect(out.BTC.mainnet.fees).to.deep.equal({ a: '1', b: '2' });
        expect(Object.keys(out)).to.deep.equal(['BTC']);
    });

    it('gives an inherited name such as toString its own plain level', function () {
        const out = mergeDelta('{"toString":{"' + MARK + '":{"m":{"p":1}}}}');
        expect(Object.prototype.toString[MARK]).to.equal(undefined);
        expect(Object.prototype.hasOwnProperty.call(out, 'toString')).to.equal(true);
        expect(out.toString[MARK]).to.deep.equal({ m: { p: 1 } });
    });
});
