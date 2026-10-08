/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * A stored permissions column that does not parse is served as
 * permissions=null with permissions_error=true, so an unreadable manifest is
 * never mistaken for an unrestricted contract (NULL column, error false).
 *********************************************************************/

'use strict';

const { sinon, expect, makeDb, cfg } = require('./core/db_data_methods.test/support/helpers.js');

const detailCfg = () => cfg({ data: { search: '900', sql: { where: { data: 'm.action_index=?', offset: '' }, order: 'DESC', limit: 1 } } });

function row(permissions) {
    return { action: 'DEPLOY', action_index: 900, code: 'x', code_hash: 'h', permissions, max_take_bps: null, meta_json: null };
}

describe('contract permissions_error', () => {
    let db;
    beforeEach(() => { db = makeDb(); });
    afterEach(() => { sinon.restore(); });

    it('getContract flags unreadable permissions JSON', async () => {
        sinon.stub(db, 'doQuery').resolves([row('{not json')]);
        const [data] = await db.getContract(detailCfg());
        expect(data.permissions).to.equal(null);
        expect(data.permissions_error).to.equal(true);
    });

    it('getContract serves a parsed array with permissions_error false', async () => {
        sinon.stub(db, 'doQuery').resolves([row('["send"]')]);
        const [data] = await db.getContract(detailCfg());
        expect(data.permissions).to.deep.equal(['send']);
        expect(data.permissions_error).to.equal(false);
    });

    it('getContract serves an absent manifest as null with permissions_error false', async () => {
        sinon.stub(db, 'doQuery').resolves([row(null)]);
        const [data] = await db.getContract(detailCfg());
        expect(data.permissions).to.equal(null);
        expect(data.permissions_error).to.equal(false);
    });

    it('getContractManifest flags unreadable permissions JSON', async () => {
        sinon.stub(db, 'doQuery').resolves([{ permissions: '[oops', max_take_bps: '250' }]);
        const m = await db.getContractManifest(cfg(), 900);
        expect(m).to.deep.equal({ permissions: null, max_take_bps: 250, permissions_error: true });
    });

    it('getContractManifest leaves permissions_error off a readable manifest', async () => {
        sinon.stub(db, 'doQuery').resolves([{ permissions: '["mint"]', max_take_bps: null }]);
        const m = await db.getContractManifest(cfg(), 900);
        expect(m).to.deep.equal({ permissions: ['mint'], max_take_bps: null });
    });
});
