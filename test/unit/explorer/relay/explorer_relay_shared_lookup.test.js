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

const proxyquire = require('proxyquire');
const sinon      = require('sinon');
const { expect } = require('chai');
const { createConfigInfoStub } = require('../../../fixtures/mock-config.js');

// Build an explorer through the entry file, which re-runs the relay's host bindings.
function makeExplorer(axiosStub) {
    const XChainExplorer = proxyquire('../../../../src/XChainExplorer.js', {
        axios:    axiosStub,
        express:  { Router: () => ({ get: () => {}, use: () => {} }), static: () => {} },
        fs:       { existsSync: () => false },
        './db/index.js': function() { this.init = () => {}; }
    });
    const app = { get: () => {}, post: () => {}, use: () => {}, listen: () => {} };
    return new XChainExplorer(app, createConfigInfoStub());
}

// The /relay DNS-rebind lookup is the shared http/ssrf_guard.js builder, so the
// relay and the IconDownloader cannot drift apart.
describe('XChainExplorer#ssrfSafeLookup shared guard', function () {
    const relay     = require('../../../../src/explorer/relay.js');
    const ssrfGuard = require('../../../../src/http/ssrf_guard.js');

    afterEach(function () {
        sinon.restore();
        // Re-bind the module the way every other test in this file leaves it.
        makeExplorer({ get: sinon.stub().resolves({ data: {} }) });
    });

    it('delegates to ssrf_guard.makeSafeLookup built from the host dns binding', function () {
        const dnsStub  = { lookup: () => {} };
        const built    = sinon.stub();
        const factory  = sinon.stub(ssrfGuard, 'makeSafeLookup').returns(built);
        relay.useHostBindings({ axios: {}, dns: dnsStub });

        const cb = () => {};
        relay.methods.ssrfSafeLookup('example.com', { all: true }, cb);

        expect(factory.calledOnceWithExactly(dnsStub)).to.be.true;
        expect(built.calledOnceWithExactly('example.com', { all: true }, cb)).to.be.true;
    });

    it('refuses to install without a dns binding instead of falling back to the real module', function () {
        const factory = sinon.spy(ssrfGuard, 'makeSafeLookup');
        expect(() => relay.useHostBindings({ axios: {} })).to.throw(/dns binding is missing/);
        expect(() => relay.useHostBindings({ axios: {}, dns: {} })).to.throw(/dns binding is missing/);
        expect(factory.called).to.be.false;
    });
});
