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

const { expect } = require('chai');
const { newRequestState } = require('../../../../src/explorer/request/state.js');

function makeInputs(){
    const debugTimer = { started: true };
    const explorer = {
        response: { status: 200, meta: { cached: false } },
        util: { startTimer: () => debugTimer }
    };
    const req = { path: '/blocks/42', query: { view: 'compact' } };
    const config = { network: 'regtest' };
    return { explorer, req, config, debugTimer };
}

describe('newRequestState', function () {
    it('builds the initial request state with an isolated response', function () {
        const { explorer, req, config, debugTimer } = makeInputs();
        const state = newRequestState(explorer, req, config);

        expect(state).to.have.all.keys(
            'config', 'response', 'debugTimer', 'total', 'data', 'dbError', 'badParam', 'cfg'
        );
        expect(state.config).to.equal(config);
        expect(state.debugTimer).to.equal(debugTimer);
        expect(state.response).to.deep.equal(explorer.response);
        expect(state.response).not.to.equal(explorer.response);
        state.response.meta.cached = true;
        expect(explorer.response.meta.cached).to.be.false;
        expect(state.total).to.be.null;
        expect(state.data).to.be.null;
        expect(state.dbError).to.be.false;
        expect(state.badParam).to.be.false;
        expect(state.cfg).to.include({ coin: null, type: null, file: null });
        expect(state.cfg.data).to.include({ method: null, search: null, type: null });
        expect(state.cfg.data.path).to.equal(req.path);
        expect(state.cfg.data.query).to.equal(req.query);
        expect(state.cfg.data.sql).to.deep.equal({
            order: null,
            limit: null,
            where: { data: '', offset: '', offsetArgs: [] }
        });
        expect(state.cfg.data.offset).to.deep.equal({ action: null, start: null, stop: null });
    });

    it('creates independent request configuration trees', function () {
        const { explorer, req, config } = makeInputs();
        const first = newRequestState(explorer, req, config);
        const second = newRequestState(explorer, req, config);

        expect(first.cfg).not.to.equal(second.cfg);
        expect(first.cfg.data).not.to.equal(second.cfg.data);
        expect(first.cfg.data.sql.where).not.to.equal(second.cfg.data.sql.where);
        expect(first.cfg.data.sql.where.offsetArgs)
            .not.to.equal(second.cfg.data.sql.where.offsetArgs);
        expect(first.cfg.data.offset).not.to.equal(second.cfg.data.offset);
    });
});
