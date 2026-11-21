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

const { EventEmitter } = require('events');
const sinon = require('sinon');
const { expect } = require('chai');
const relay = require('../../../../src/explorer/relay.js');

function makeExplorer(){
    return {
        util: { isNull: (value) => value === null || value === undefined, jsonStringify: JSON.stringify },
        db: { pools: {} },
        relayDestinationRefusal: relay.methods.relayDestinationRefusal,
        tokenMetadataReference: relay.methods.tokenMetadataReference,
        relayContent: relay.methods.relayContent,
        ssrfSafeLookup: relay.methods.ssrfSafeLookup,
        isPrivateAddress: relay.methods.isPrivateAddress,
    };
}

function makeResponse(){
    const res = new EventEmitter();
    const release = sinon.spy();
    res.destroyed = false;
    res.writableEnded = false;
    res.headersSent = false;
    res.holdSlot = sinon.stub().returns(release);
    res.status = sinon.stub().returns(res);
    res.json = sinon.stub().returns(res);
    res.type = sinon.stub().returns(res);
    res.send = sinon.stub().returns(res);
    return { res, release };
}

function bindAxios(axios){
    relay.useHostBindings({ axios, dns: { lookup: sinon.stub() } });
}

describe('Relay egress deadline', function () {
    it('aborts the upstream fetch on client close and releases the held slot', async function () {
        let requestSignal;
        const axios = { get: sinon.stub().callsFake((url, opts) => {
            requestSignal = opts.signal;
            return new Promise((resolve, reject) => {
                opts.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
            });
        }) };
        bindAxios(axios);
        const { res, release } = makeResponse();
        const req = { query: { url: 'https://arweave.net/meta.json' } };

        const pending = relay.methods.processRelayRequest.call(makeExplorer(), req, res);
        await new Promise((resolve) => setImmediate(resolve));
        expect(requestSignal.aborted).to.equal(false);
        res.destroyed = true;
        res.emit('close');
        await pending;

        expect(requestSignal.aborted).to.equal(true);
        expect(res.holdSlot.calledOnce).to.equal(true);
        expect(release.calledOnce).to.equal(true);
        expect(res.status.called).to.equal(false);
    });

    it('releases the held slot after a successful fetch', async function () {
        bindAxios({ get: sinon.stub().resolves({ data: { ok: true } }) });
        const { res, release } = makeResponse();

        const sent = await relay.methods.relayContent.call(
            makeExplorer(), new URL('https://arweave.net/meta.json'), res);

        expect(sent).to.equal(true);
        expect(release.calledOnce).to.equal(true);
    });

    it('releases the held slot after a failed fetch', async function () {
        bindAxios({ get: sinon.stub().rejects(new Error('network failed')) });
        const { res, release } = makeResponse();

        let error;
        try {
            await relay.methods.relayContent.call(
                makeExplorer(), new URL('https://arweave.net/meta.json'), res);
        } catch (e) { error = e; }

        expect(error.message).to.equal('network failed');
        expect(release.calledOnce).to.equal(true);
    });
});
