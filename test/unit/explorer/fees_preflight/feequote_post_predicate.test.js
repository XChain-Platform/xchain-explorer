'use strict';

const { expect } = require('chai');
const XChainExplorer = require('../../../../src/XChainExplorer.js');

describe('isFeeQuotePostRequest', function () {
    const f = XChainExplorer.isFeeQuotePostRequest;
    it('matches POST /{COIN}/api/feequote', function () {
        expect(f({ method: 'POST', path: '/BTC/api/feequote' })).to.equal(true);
        expect(f({ method: 'post', path: '/RBTC/api/feequote/' })).to.equal(true);
    });
    it('rejects other methods and paths', function () {
        expect(f({ method: 'GET', path: '/BTC/api/feequote' })).to.equal(false);
        expect(f({ method: 'POST', path: '/BTC/api/preflight' })).to.equal(false);
        expect(f({ method: 'POST', path: '/BTC/api/feequote/x' })).to.equal(false);
        expect(f(null)).to.equal(false);
    });
});
