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

// A hub that ANSWERS a hub-only operational read with an application error (a
// hub run without its slash detector answers getslashproposals with
// {error: "slash detector not active"}) is reachable. The 503 the reader raises
// with nothing cached must name that cause, never "Hub unreachable", or the
// operator is sent to restore a hub that is up. A genuinely unreachable hub keeps
// the outage error, and cached rows inside the stale ceiling are still served.

const proxyquire = require('proxyquire');
const { sinon, expect, loadCache, makeDb, listConfig } = require('../hub_operational_cache.test/support/helpers.js');

const CAUSE = 'slash detector not active';

const { loadData } = proxyquire('../../../../src/explorer/request/load_data.js', {
    '../../observability': { getLogger: () => ({ error: () => {}, warn: () => {}, info: () => {} }) }
});

// The real cache over a stubbed connector, behind the real governance reader.
function slashFixture(callResult, env = {}) {
    const { cache, callStub } = loadCache({ callResult, env });
    const db = makeDb(cache);
    db.explorer = { hubOperational: cache };
    return { cache, callStub, db };
}

async function readSlash(db) {
    try { await db.getSlashProposals(listConfig('getSlashProposals')); }
    catch (e) { return e; }
    throw new Error('getSlashProposals resolved; expected a 503-coded rejection');
}

describe('hub operational reads: a hub application error is not an outage', function () {
    afterEach(function () { sinon.restore(); });

    it('names the hub-reported cause instead of "Hub unreachable"', async function () {
        const { db } = slashFixture({ error: CAUSE });
        const err = await readSlash(db);
        expect(err.name).to.equal('HubUnavailableError');
        expect(err.message).to.contain(CAUSE);
        expect(err.message).to.contain('slash_proposals');
        expect(err.message).to.not.match(/Hub unreachable/);
    });

    it('keeps naming the cause on repeat reads answered from the failure memo', async function () {
        const { db, callStub } = slashFixture({ error: CAUSE });
        await readSlash(db);
        for (let i = 0; i < 5; i++) {
            const err = await readSlash(db);
            expect(err.message, 'read ' + (i + 2)).to.contain(CAUSE);
            expect(err.message).to.not.match(/Hub unreachable/);
        }
        expect(callStub.callCount, 'repeat reads inside the TTL reuse the memo').to.equal(1);
    });

    it('answers 503 with a body that names the cause through the request layer', async function () {
        const { db } = slashFixture({ error: CAUSE });
        const st = { cfg: listConfig('getSlashProposals'), response: { code: 200, json: null } };
        const explorer = { db: { getData: () => db.getSlashProposals(st.cfg) } };
        await loadData(explorer, { path: '/slash_proposals' }, st);
        expect(st.response.code).to.equal(503);
        expect(st.response.json.error).to.contain(CAUSE);
        expect(st.response.json.error).to.not.match(/Hub unreachable/);
    });

    it('flattens and bounds the hub string echoed into the body', async function () {
        const { db } = slashFixture({ error: 'line one\nline two ' + 'x'.repeat(400) });
        const err = await readSlash(db);
        expect(err.message).to.contain('line one line two');
        expect(err.message).to.not.contain('\n');
        expect(err.message).to.not.contain('x'.repeat(201));
    });

});

describe('hub operational reads: outage and stale-bridge controls', function () {
    afterEach(function () { sinon.restore(); });

    it('control: an unreachable hub (null, no error) still raises "Hub unreachable"', async function () {
        const { db } = slashFixture(null);
        const err = await readSlash(db);
        expect(err.name).to.equal('HubUnavailableError');
        expect(err.code).to.equal('HUB_UNAVAILABLE');
        expect(err.message).to.contain('Hub unreachable');
    });

    it('control: an outage after an application error drops the old cause', async function () {
        const { db, callStub } = slashFixture({ error: CAUSE });
        expect((await readSlash(db)).message).to.contain(CAUSE);
        // Inside the same TTL window, a different key of the same method meets an
        // unreachable hub: the earlier cause must not be pinned on this outage.
        callStub.resolves(null);
        let err = null;
        try { await db.getSlashProposals(listConfig('getSlashProposals', { search: 'pending', type: 'status' })); }
        catch (e) { err = e; }
        expect(err.message).to.contain('Hub unreachable');
        expect(err.message).to.not.contain(CAUSE);
    });

    it('every hub-served table asks the cache under the method it is read with', async function () {
        const tables = {
            validator_capabilities: 'getvalidatorcapabilities',
            governance_proposals:   'getproposals',
            governance_votes:       'getvotes',
            reorg_attestations:     'getreorghistory',
            slash_proposals:        'getslashproposals'
        };
        for (const [table, method] of Object.entries(tables)) {
            const { cache, db } = slashFixture({ error: method + ' subsystem off' });
            expect(await cache.getRows(method, {})).to.equal(null);
            let err = null;
            try { db.hubOperationalOutage(table); } catch (e) { err = e; }
            expect(err.message, table).to.contain(method + ' subsystem off');
        }
    });

    it('control: cached rows inside the stale ceiling are still served on an application error', async function () {
        const clock = sinon.useFakeTimers();
        try {
            const { db, callStub } = slashFixture([{ id: 4, status: 'pending' }],
                { EXPLORER_HUB_CACHE_MS: '1000', EXPLORER_HUB_CACHE_STALE_MAX_MS: '60000' });
            await db.getSlashProposals(listConfig('getSlashProposals'));
            clock.tick(1500);
            callStub.resolves({ error: CAUSE });
            const [served, , total] = await db.getSlashProposals(listConfig('getSlashProposals'));
            expect(callStub.callCount).to.equal(2);
            expect(total).to.equal(1);
            expect(served.map(r => r.id)).to.deep.equal(['4']);
        } finally { clock.restore(); }
    });
});
