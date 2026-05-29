'use strict';

const sinon      = require('sinon');
const { expect } = require('chai');
const proxyquire = require('proxyquire').noCallThru();

// Collapse retry backoff to zero so the retry-path tests run instantly.
// The connector reads this env var in its constructor.
process.env.HUB_RETRY_DELAY_MS = '0';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAxiosStub() {
    return { post: sinon.stub() };
}

function loadConnector(axiosStub) {
    return proxyquire('../../src/XChainHubConnector', {
        'axios': axiosStub
    });
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('XChainHubConnector', function () {

    // -----------------------------------------------------------------------
    // Constructor
    // -----------------------------------------------------------------------

    describe('constructor', function () {

        it('builds the URL as http://<url>:<port>', function () {
            const axiosStub = makeAxiosStub();
            const XChainHubConnector = loadConnector(axiosStub);
            const connector = new XChainHubConnector('localhost', 3000);
            expect(connector.url).to.equal('http://localhost:3000');
        });

        it('stores the port on the instance', function () {
            const axiosStub = makeAxiosStub();
            const XChainHubConnector = loadConnector(axiosStub);
            const connector = new XChainHubConnector('127.0.0.1', 8765);
            expect(connector.port).to.equal(8765);
        });

    });

    // -----------------------------------------------------------------------
    // ping()
    // -----------------------------------------------------------------------

    describe('ping()', function () {

        it('returns true when the response contains a result', async function () {
            const axiosStub = makeAxiosStub();
            axiosStub.post.resolves({ data: { result: 'pong' } });
            const XChainHubConnector = loadConnector(axiosStub);
            const connector = new XChainHubConnector('localhost', 3000);
            const result = await connector.ping();
            expect(result).to.be.true;
        });

        it('POSTs a JSON-RPC ping payload to the connector URL', async function () {
            const axiosStub = makeAxiosStub();
            axiosStub.post.resolves({ data: { result: 'pong' } });
            const XChainHubConnector = loadConnector(axiosStub);
            const connector = new XChainHubConnector('localhost', 3000);
            await connector.ping();
            const [url, payload] = axiosStub.post.firstCall.args;
            expect(url).to.equal('http://localhost:3000');
            expect(payload).to.deep.include({ method: 'ping' });
        });

        it('returns false when the response has no result field', async function () {
            const axiosStub = makeAxiosStub();
            axiosStub.post.resolves({ data: {} });
            const XChainHubConnector = loadConnector(axiosStub);
            const connector = new XChainHubConnector('localhost', 3000);
            const result = await connector.ping();
            expect(result).to.be.false;
        });

        it('returns false when the result field is falsy', async function () {
            const axiosStub = makeAxiosStub();
            axiosStub.post.resolves({ data: { result: null } });
            const XChainHubConnector = loadConnector(axiosStub);
            const connector = new XChainHubConnector('localhost', 3000);
            const result = await connector.ping();
            expect(result).to.be.false;
        });

        it('returns false on a network error', async function () {
            const axiosStub = makeAxiosStub();
            axiosStub.post.rejects(new Error('ECONNREFUSED'));
            const XChainHubConnector = loadConnector(axiosStub);
            const connector = new XChainHubConnector('localhost', 3000);
            const result = await connector.ping();
            expect(result).to.be.false;
        });

    });

    // -----------------------------------------------------------------------
    // getAllConfig()
    // -----------------------------------------------------------------------

    describe('getAllConfig()', function () {

        it('returns the result data on a successful response', async function () {
            const mockResult = { bitcoin: { mainnet: { indexer: {}, decoder: {} } } };
            const axiosStub  = makeAxiosStub();
            axiosStub.post.resolves({ data: { result: mockResult } });
            const XChainHubConnector = loadConnector(axiosStub);
            const connector = new XChainHubConnector('localhost', 3000);
            const result = await connector.getAllConfig();
            expect(result).to.deep.equal(mockResult);
        });

        it('POSTs a JSON-RPC getallconfigs payload with a 5000ms timeout', async function () {
            const axiosStub = makeAxiosStub();
            axiosStub.post.resolves({ data: { result: {} } });
            const XChainHubConnector = loadConnector(axiosStub);
            const connector = new XChainHubConnector('localhost', 3000);
            await connector.getAllConfig();
            const [, payload, options] = axiosStub.post.firstCall.args;
            expect(payload).to.deep.include({ method: 'getallconfigs' });
            expect(options).to.deep.include({ timeout: 5000 });
        });

        it('returns null on a timeout error', async function () {
            const axiosStub = makeAxiosStub();
            const timeoutErr = new Error('timeout of 5000ms exceeded');
            timeoutErr.code  = 'ECONNABORTED';
            axiosStub.post.rejects(timeoutErr);
            const XChainHubConnector = loadConnector(axiosStub);
            const connector = new XChainHubConnector('localhost', 3000);
            const result = await connector.getAllConfig();
            expect(result).to.be.null;
        });

        it('returns null on a general network error', async function () {
            const axiosStub = makeAxiosStub();
            axiosStub.post.rejects(new Error('ECONNREFUSED'));
            const XChainHubConnector = loadConnector(axiosStub);
            const connector = new XChainHubConnector('localhost', 3000);
            const result = await connector.getAllConfig();
            expect(result).to.be.null;
        });

        it('logs the error message when the request fails', async function () {
            const axiosStub    = makeAxiosStub();
            const consoleStub  = sinon.stub(console, 'error');
            axiosStub.post.rejects(new Error('network down'));
            const XChainHubConnector = loadConnector(axiosStub);
            const connector = new XChainHubConnector('localhost', 3000);
            await connector.getAllConfig();
            expect(consoleStub.calledOnce).to.be.true;
            expect(consoleStub.firstCall.args.join(' ')).to.include('network down');
            consoleStub.restore();
        });

        it('returns null when the response has no result field', async function () {
            const axiosStub = makeAxiosStub();
            axiosStub.post.resolves({ data: {} });
            const XChainHubConnector = loadConnector(axiosStub);
            const connector = new XChainHubConnector('localhost', 3000);
            const result = await connector.getAllConfig();
            expect(result).to.be.null;
        });

    });

    // -----------------------------------------------------------------------
    // Retry behavior — bridges the startup race where the hub is still booting
    // -----------------------------------------------------------------------

    describe('getAllConfig() retry behavior', function () {

        it('retries the endpoint pass HUB_RETRY_ATTEMPTS times before returning null', async function () {
            const savedAttempts = process.env.HUB_RETRY_ATTEMPTS;
            process.env.HUB_RETRY_ATTEMPTS = '4';
            try {
                const axiosStub = makeAxiosStub();
                axiosStub.post.rejects(new Error('ECONNREFUSED'));
                const XChainHubConnector = loadConnector(axiosStub);
                const connector = new XChainHubConnector('localhost', 3000);
                const result = await connector.getAllConfig();
                expect(result).to.be.null;
                // One endpoint × 4 attempts
                expect(axiosStub.post.callCount).to.equal(4);
            } finally {
                if (savedAttempts !== undefined) process.env.HUB_RETRY_ATTEMPTS = savedAttempts;
                else delete process.env.HUB_RETRY_ATTEMPTS;
            }
        });

        it('returns the result once an endpoint recovers on a later attempt', async function () {
            const mockResult = { bitcoin: { mainnet: { indexer: {}, decoder: {} } } };
            const axiosStub  = makeAxiosStub();
            // First pass fails, second pass succeeds — the hub finished booting.
            axiosStub.post.onFirstCall().rejects(new Error('ECONNREFUSED'));
            axiosStub.post.onSecondCall().resolves({ data: { result: mockResult } });
            const XChainHubConnector = loadConnector(axiosStub);
            const connector = new XChainHubConnector('localhost', 3000);
            const result = await connector.getAllConfig();
            expect(result).to.deep.equal(mockResult);
            expect(axiosStub.post.callCount).to.equal(2);
        });

        it('ping() does not retry — a single attempt only', async function () {
            const axiosStub = makeAxiosStub();
            axiosStub.post.rejects(new Error('ECONNREFUSED'));
            const XChainHubConnector = loadConnector(axiosStub);
            const connector = new XChainHubConnector('localhost', 3000);
            const result = await connector.ping();
            expect(result).to.be.false;
            expect(axiosStub.post.callCount).to.equal(1);
        });

    });

});
