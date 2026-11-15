/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 ********************************************************************/

'use strict';

const { expect } = require('chai');
const sinon      = require('sinon');
const welcome    = require('../../../../src/ws/websocket_server/welcome.js');
const { COIN_MAP } = require('../../../../src/ws/broadcaster/coin_map.js');

describe('WebSocket WELCOME supported coin resolution', function () {

    it('resolves supported coin codes to chain and network', function () {
        const subject = Object.create(welcome);

        expect(subject.resolveCoin('BTC')).to.deep.equal({ chain: 'BTC', network: 'mainnet' });
        expect(subject.resolveCoin('TBTC')).to.deep.equal({ chain: 'BTC', network: 'testnet' });
        expect(subject.resolveCoin('RLTC')).to.deep.equal({ chain: 'LTC', network: 'regtest' });
        expect(subject.resolveCoin('DOGE')).to.deep.equal({ chain: 'DOGE', network: 'mainnet' });
    });

    it('does not resolve unknown or lowercase coin codes', function () {
        const subject = Object.create(welcome);

        expect(subject.resolveCoin('XYZ')).to.be.undefined;
        expect(subject.resolveCoin('btc')).to.be.undefined;
    });

    it('loads exactly the nine supported coin codes', function () {
        const subject = Object.create(welcome);
        subject.loadValidCoins();

        expect(Object.keys(subject.validCoins)).to.have.members([
            'BTC', 'TBTC', 'RBTC',
            'LTC', 'TLTC', 'RLTC',
            'DOGE', 'TDOGE', 'RDOGE'
        ]).and.to.have.lengthOf(9);
    });

    it('loads an isolated copy of the broadcaster coin map', function () {
        const subject = Object.create(welcome);
        subject.loadValidCoins();

        expect(subject.validCoins).to.deep.equal(COIN_MAP);
        expect(subject.validCoins).not.to.equal(COIN_MAP);
        expect(subject.validCoins.BTC).not.to.equal(COIN_MAP.BTC);
    });

});

describe('WebSocket WELCOME coin map loading', function () {

    afterEach(function () {
        sinon.restore();
    });

    it('loads the coin map lazily only once', function () {
        const subject = Object.create(welcome);
        const loadValidCoins = sinon.spy(subject, 'loadValidCoins');

        subject.resolveCoin('BTC');
        subject.resolveCoin('TLTC');

        expect(loadValidCoins.callCount).to.equal(1);
    });

    it('uses a preset coin map without loading a replacement', function () {
        const subject = Object.create(welcome);
        const preset = { CUSTOM: { chain: 'CUSTOM', network: 'regtest' } };
        subject.validCoins = preset;
        const loadValidCoins = sinon.spy(subject, 'loadValidCoins');

        expect(subject.resolveCoin('CUSTOM')).to.equal(preset.CUSTOM);
        expect(subject.validCoins).to.equal(preset);
        expect(loadValidCoins.called).to.equal(false);
    });

    it('returns null when loading leaves the coin map unavailable', function () {
        const subject = Object.create(welcome);
        subject.validCoins = null;
        sinon.stub(subject, 'loadValidCoins');

        expect(subject.resolveCoin('BTC')).to.be.null;
    });

    it('gets resolved coin info and falls back for unknown codes', function () {
        const subject = Object.create(welcome);

        expect(subject.getCoinInfo('TDOGE')).to.deep.equal({ chain: 'DOGE', network: 'testnet' });
        expect(subject.getCoinInfo('XYZ')).to.deep.equal({ chain: 'XYZ', network: 'mainnet' });
    });

});
