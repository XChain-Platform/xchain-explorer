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

const { sinon, expect, makeAxiosStub, loadConnector } = require('./helpers.js');

    // The hub redacts secret-bearing config params (rpc/DB passwords) unless the
    // caller asks with include_secrets. The explorer is one of only two services
    // that genuinely needs them: db.js builds every MariaDB pool out of this tree,
    // so a redacted response authenticates every pool with the literal
    // "[redacted]" and the explorer serves nothing.
const savedKeys = {};

function registerCredentialRequests() {
    describe('getAllConfig() credential tier', function () {
        beforeEach(function () {
            for (const k of ['HUB_API_KEY', 'HUB_CONFIG_SECRETS_API_KEY']) {
                savedKeys[k] = process.env[k];
                delete process.env[k];
            }
        });
        afterEach(function () {
            for (const [k, v] of Object.entries(savedKeys)) {
                if (v === undefined) delete process.env[k];
                else process.env[k] = v;
            }
        });

        it('asks for secrets on the initial fetch', async function () {
            const axiosStub = makeAxiosStub();
            axiosStub.post.resolves({ data: { result: {} } });
            const Connector = loadConnector(axiosStub);
            await new Connector(['http://a:1']).getAllConfig();
            expect(axiosStub.post.firstCall.args[1].params).to.deep.equal({
                since_updated_at: 0, include_secrets: true
            });
        });

        it('keeps asking on the delta poll, cursor and all', async function () {
            const axiosStub = makeAxiosStub();
            axiosStub.post.resolves({ data: { result: { configs: {}, seq: 1, watermark: 5000 } } });
            const Connector = loadConnector(axiosStub);
            const c = new Connector(['http://a:1']);
            await c.getAllConfig();
            await c.getAllConfig();
            // Cursor is deliberately one second behind the watermark (item #2265).
            expect(axiosStub.post.secondCall.args[1].params).to.deep.equal({
                since_updated_at: 4999, include_secrets: true
            });
        });

        it('sends HUB_CONFIG_SECRETS_API_KEY when the hub splits the credential tier', async function () {
            process.env.HUB_API_KEY = 'bulk-key';
            process.env.HUB_CONFIG_SECRETS_API_KEY = 'secrets-key';
            const axiosStub = makeAxiosStub();
            axiosStub.post.resolves({ data: { result: {} } });
            const Connector = loadConnector(axiosStub);
            await new Connector(['http://a:1']).getAllConfig();
            expect(axiosStub.post.firstCall.args[2].headers['x-api-key']).to.equal('secrets-key');
        });

        it('falls back to the bulk key when the hub does not split the tier', async function () {
            process.env.HUB_API_KEY = 'bulk-key';
            const axiosStub = makeAxiosStub();
            axiosStub.post.resolves({ data: { result: {} } });
            const Connector = loadConnector(axiosStub);
            await new Connector(['http://a:1']).getAllConfig();
            expect(axiosStub.post.firstCall.args[2].headers['x-api-key']).to.equal('bulk-key');
        });
    });
}

function registerCredentialWarnings() {
    describe('getAllConfig() credential tier', function () {
        beforeEach(function () {
            for (const k of ['HUB_API_KEY', 'HUB_CONFIG_SECRETS_API_KEY']) {
                savedKeys[k] = process.env[k];
                delete process.env[k];
            }
        });
        afterEach(function () {
            for (const [k, v] of Object.entries(savedKeys)) {
                if (v === undefined) delete process.env[k];
                else process.env[k] = v;
            }
        });

        it('names the cause once when the hub redacts anyway (unauthorized for credentials)', async function () {
            const err = sinon.stub(console, 'error');
            try {
                const axiosStub = makeAxiosStub();
                axiosStub.post.resolves({ data: { result: {
                    configs: {}, seq: 1, watermark: 5000, secrets_redacted: true, redacted_params: 4
                } } });
                const Connector = loadConnector(axiosStub);
                const c = new Connector(['http://a:1']);
                await c.getAllConfig();
                await c.getAllConfig();
                const hits = err.getCalls().filter((call) => /CREDENTIAL-REDACTED/.test(String(call.args[0])));
                expect(hits.length, 'exactly one warning, not one per poll').to.equal(1);
                expect(hits[0].args[0]).to.include('4 params withheld');
            } finally { err.restore(); }
        });

        it('says nothing when the hub served the credentials', async function () {
            const err = sinon.stub(console, 'error');
            try {
                const axiosStub = makeAxiosStub();
                axiosStub.post.resolves({ data: { result: {
                    configs: {}, seq: 1, watermark: 5000, secrets_redacted: false, redacted_params: 0
                } } });
                const Connector = loadConnector(axiosStub);
                await new Connector(['http://a:1']).getAllConfig();
                expect(err.getCalls().some((call) => /CREDENTIAL-REDACTED/.test(String(call.args[0]))))
                    .to.equal(false);
            } finally { err.restore(); }
        });
    });
}

module.exports = [registerCredentialRequests, registerCredentialWarnings];
