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

// Hub operational-state cache (validator_capabilities / governance_proposals /
// governance_votes over hub JSON-RPC) and the RPC-first read path in db/index.js:
// TTL/stale cache behavior, endpoint resolution, filter param mapping, and JS
// paging parity with the SQL cursor semantics it replaces.

const { sinon, expect, loadCache, serveAfterOutage, makeDb, rows, listConfig, makeRpcDispatchFixture, makeConfig } = require('./helpers.js');

describe("db.js RPC-first operational reads", function () {
    describe('_pageHubOperationalRows()', function () {
        it('default action: DESC order, LIMIT window, total = filtered count', function () {
            const db  = makeDb(null);
            const cfg = listConfig('getGovernanceVotes', { sql: { limit: 3 } });
            const [page, args, total] = db.pageHubOperationalRows(cfg, rows(10));
            expect(args).to.equal(null);
            expect(total).to.equal(10);
            expect(page.map(r => r.id)).to.deep.equal(['10', '9', '8']);
        });

        it("action 'next': id < start window", function () {
            const db  = makeDb(null);
            const cfg = listConfig('getGovernanceVotes', { sql: { limit: 3 }, offset: { action: 'next', start: 8, stop: null } });
            const [page, , total] = db.pageHubOperationalRows(cfg, rows(10));
            expect(page.map(r => r.id)).to.deep.equal(['7', '6', '5']);
            expect(total).to.equal(10, 'total ignores the cursor window, matching the SQL count query');
        });

        it("action 'prev': id > start, ASC order (reversed downstream)", function () {
            const db  = makeDb(null);
            const cfg = listConfig('getGovernanceVotes', { sql: { order: 'ASC', limit: 3 }, offset: { action: 'prev', start: 4, stop: null } });
            const [page] = db.pageHubOperationalRows(cfg, rows(10));
            expect(page.map(r => r.id)).to.deep.equal(['5', '6', '7']);
        });

        it("action 'last': id <= start, ASC order", function () {
            const db  = makeDb(null);
            const cfg = listConfig('getGovernanceVotes', { sql: { order: 'ASC', limit: 3 }, offset: { action: 'last', start: 3, stop: null } });
            const [page] = db.pageHubOperationalRows(cfg, rows(10));
            expect(page.map(r => r.id)).to.deep.equal(['1', '2', '3']);
        });

        it('api paging applies apiOffset slice', function () {
            const db  = makeDb(null);
            const cfg = makeConfig({ type: 'api', data: { method: 'getGovernanceVotes', sql: { limit: 3, apiOffset: 3 } } });
            const [page] = db.pageHubOperationalRows(cfg, rows(10));
            expect(page.map(r => r.id)).to.deep.equal(['7', '6', '5']);
        });

        // The hub's pool sets bigIntAsNumber, so the RPC transport delivers these
        // BIGINT columns as JS Numbers while the legacy co-located-schema read
        // delivers BigInt that the response sink stringifies. Both must reach
        // consumers as decimal strings, or a hub outage flips the wire type of
        // /validator_capabilities, /governance_proposals and /governance_votes
        // mid-deployment.
        it('normalizes BIGINT id columns to decimal strings on the RPC path', function () {
            const db  = makeDb(null);
            const cfg = listConfig('getValidatorCapabilities', { sql: { limit: 5 } });
            const [page] = db.pageHubOperationalRows(cfg, [
                { id: 2, capability: 'price',       qualified_at_block: 900001 },
                { id: 1, capability: 'cross_chain', qualified_at_block: null }
            ]);
            expect(page.map(r => r.id)).to.deep.equal(['2', '1']);
            expect(page[0].qualified_at_block).to.equal('900001');
            expect(page[1].qualified_at_block).to.equal(null, 'a null BIGINT stays null');
            expect(page[0].capability).to.equal('price', 'non-BIGINT columns pass through');
        });
    });
});

describe("db.js RPC-first operational reads", function () {
    describe('_pageHubOperationalRows()', function () {
        it('leaves a BIGINT column absent from the row shape absent', function () {
            const db  = makeDb(null);
            const cfg = listConfig('getGovernanceVotes', { sql: { limit: 5 } });
            const [page] = db.pageHubOperationalRows(cfg, [{ id: 7, proposal_id: 'p-1', vote: 'approve' }]);
            expect(page[0].id).to.equal('7');
            expect(page[0]).to.not.have.property('qualified_at_block');
            expect(page[0]).to.not.have.property('activation_block');
        });

        it('stringifies governance_proposals activation_block', function () {
            const db  = makeDb(null);
            const cfg = listConfig('getGovernanceProposals', { sql: { limit: 5 } });
            const [page] = db.pageHubOperationalRows(cfg, [{ id: 4, proposal_id: 'p-9', activation_block: 910000 }]);
            expect(page[0].activation_block).to.equal('910000');
        });
    });
});

describe("db.js RPC-first operational reads", function () {
    describe('RPC-first dispatch, fail-loud on hub outage', function () {
        it('uses the RPC cache and maps the type filter to params', async function () {
            const { ops, db, cfg } = makeRpcDispatchFixture();
            const [page, , total] = await db.getValidatorCapabilities(cfg);
            expect(ops.getValidatorCapabilities.firstCall.args[0]).to.deep.equal({
                capability: 'price', signing_pubkey: undefined
            });
            expect(total).to.equal(1);
            expect(page[0].id).to.equal('3');
        });

        // Deliberate inverse of falling through to the co-located hub schema on a
        // cache miss: that schema has no freshness bound, so the fall-through would
        // make HubOperationalCache's 600s stale ceiling unenforceable. Once a hub
        // endpoint is configured, these tables are served from the hub or not at
        // all. Do not restore the fall-through.
        const failLoudCases = [
            ['getValidatorCapabilities', 'validator_capabilities'],
            ['getGovernanceProposals',   'governance_proposals'],
            ['getGovernanceVotes',       'governance_votes']
        ];
        for (const [method, table] of failLoudCases) {
            it('fails loud instead of reading the co-located schema when ' + method
                + ' passes the stale ceiling', async function () {
                const ops = { enabled: () => true, staleMaxMs: 600000, [method]: sinon.stub().resolves(null) };
                const db  = makeDb(ops);
                // A co-located hub schema IS configured here: that is exactly the
                // deployment shape the old fall-through served stale rows from.
                db.checkpointDb = { BTC: { name: 'XChain_Hub', chain: 'BTC', network: 'mainnet' } };
                let err = null;
                try { await db[method](listConfig(method)); }
                catch (e) { err = e; }
                expect(err).to.be.an('error', method + ' must throw, never fall through to SQL');
                expect(err.message).to.contain(table);
                expect(err.message).to.contain('Hub unreachable');
                expect(err.message).to.contain('600s');
                expect(err.message).to.not.contain('XChain_Hub');
            });
        }

        it('propagates a method-unsupported throw as-is, never rewritten into the outage error', async function () {
            const unsupported = new Error("Hub JSON-RPC method 'getvalidatorcapabilities' is not supported "
                + 'by the configured hub (JSON-RPC -32601 Method not found).');
            const ops = { enabled: () => true, staleMaxMs: 600000,
                          getValidatorCapabilities: sinon.stub().rejects(unsupported) };
            const db  = makeDb(ops);
            db.checkpointDb = { BTC: { name: 'XChain_Hub', chain: 'BTC', network: 'mainnet' } };
            let err = null;
            try { await db.getValidatorCapabilities(listConfig('getValidatorCapabilities')); }
            catch (e) { err = e; }
            expect(err).to.be.an('error');
            expect(err.message).to.contain('-32601');
            expect(err.message).to.not.contain('Hub unreachable');
        });
    });
});

describe("db.js RPC-first operational reads", function () {
    describe('RPC-first dispatch, fail-loud on hub outage', function () {
        it('reports the configured stale ceiling in the outage error', async function () {
            const ops = { enabled: () => true, staleMaxMs: 90000, getGovernanceVotes: sinon.stub().resolves(null) };
            const db  = makeDb(ops);
            db.checkpointDb = { BTC: { name: 'XChain_Hub', chain: 'BTC', network: 'mainnet' } };
            let err = null;
            try { await db.getGovernanceVotes(listConfig('getGovernanceVotes')); }
            catch (e) { err = e; }
            expect(err.message).to.contain('90s');
        });

        // The no-hub deployment shape is unchanged: with no endpoint configured the
        // cache is disabled and the co-located schema read is the ONLY transport.
        it('reads the co-located schema SQL when no hub endpoint is configured', async function () {
            const db  = makeDb({ enabled: () => false });
            db.checkpointDb = { BTC: { name: 'XChain_Hub', chain: 'BTC', network: 'mainnet' } };
            const [query, , count] = await db.getGovernanceVotes(listConfig('getGovernanceVotes'));
            expect(query).to.contain('`XChain_Hub`.governance_votes');
            expect(count).to.contain('count(*)');
        });

        it('throws loud when neither a hub endpoint nor a co-located schema exists', async function () {
            const db  = makeDb({ enabled: () => false });
            db.checkpointDb = {};
            let err = null;
            try { await db.getGovernanceProposals(listConfig('getGovernanceProposals')); }
            catch (e) { err = e; }
            expect(err).to.be.an('error');
            expect(err.message).to.contain('governance_proposals');
            expect(err.message).to.contain('No co-located hub DB configured');
        });

        // getFederationRegistry is the sanctioned exception: it decorates the on-chain
        // /validators set, so a hub outage must degrade the decoration rather than
        // blank a page of consensus data.
        it('getFederationRegistry still falls back to the schema read on a hub outage', async function () {
            const ops = { enabled: () => true, staleMaxMs: 600000, getFederationValidators: sinon.stub().resolves(null) };
            const db  = makeDb(ops);
            db.checkpointDb = { BTC: { name: 'XChain_Hub', chain: 'BTC', network: 'mainnet' } };
            db.doQuery = sinon.stub().resolves([{ signing_pubkey: 'AA', addr: 'bc1q', chains: 'BTC', status: 'active' }]);
            const registry = await db.getFederationRegistry(makeConfig({ type: 'explorer', data: { method: 'getValidators' } }));
            // Both hub sources fall back to the schema: the manual registry first,
            // then the capability rows that the merged status is derived from.
            expect(db.doQuery.firstCall.args[1]).to.contain('validators');
            expect(registry).to.have.property('aa');
            expect(registry.aa.status).to.equal('active');
        });
    });
});
