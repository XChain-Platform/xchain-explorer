'use strict';

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
 **********************************************************************
 * Unit tests for XChainExplorer.getPagingDataResults(config, data, total)
 */

const {
    expect, makeApiConfig, makeExplorerConfig, makeSend, makeBalance, makeHolder,
    makeAddress, makeIssue, makeBlock, toNum, state
} = require('./helpers.js');

let explorer;
before(function () { explorer = state.explorer; });

describe('method: getSearch', function () {
    it('getSearch extracts data.data before processing', function () {
        // The method unwraps data.data when method==getSearch
        const rows = [{ address: 'foundAddr1' }, { address: 'foundAddr2' }];
        const wrapper = { data: rows };
        const cfg = makeExplorerConfig('getSearch', null, 'address', { start: 0, length: 10 });
        const result = explorer.getPagingDataResults(cfg, wrapper, 2);
        expect(result).to.have.length(2);
    });

    it('search type=address returns [count, address, null]', function () {
        const rows = [{ address: 'myAddr' }];
        const wrapper = { data: rows };
        const cfg = makeExplorerConfig('getSearch', null, 'address', { start: 0, length: 10 });
        const result = explorer.getPagingDataResults(cfg, wrapper, 1);
        const r = result[0];
        expect(r).to.deep.equal([result[0][0], 'myAddr', null]);
        expect(toNum(r[0])).to.equal(1);
    });

    it('search type=broadcast returns [count, message, memo, action_index]', function () {
        const rows = [{ message: 'hello world', memo: 'some memo', action_index: 7 }];
        const wrapper = { data: rows };
        const cfg = makeExplorerConfig('getSearch', null, 'broadcast', { start: 0, length: 10 });
        const result = explorer.getPagingDataResults(cfg, wrapper, 1);
        const r = result[0];
        expect(r).to.be.an('array').with.length(4);
        expect(r[1]).to.equal('hello world');
        expect(r[2]).to.equal('some memo');
        expect(r[3]).to.equal(7);
    });

    it('search type=token returns [count, tick, description, null]', function () {
        const rows = [{ tick: 'XCHAIN', description: 'Gas Token' }];
        const wrapper = { data: rows };
        const cfg = makeExplorerConfig('getSearch', null, 'token', { start: 0, length: 10 });
        const result = explorer.getPagingDataResults(cfg, wrapper, 1);
        const r = result[0];
        expect(r).to.be.an('array').with.length(4);
        expect(r[1]).to.equal('XCHAIN');
        expect(r[2]).to.equal('Gas Token');
        expect(r[3]).to.be.null;
    });

    it('search type=transaction returns [count, hash, null]', function () {
        const rows = [{ hash: 'txhash123' }];
        const wrapper = { data: rows };
        const cfg = makeExplorerConfig('getSearch', null, 'transaction', { start: 0, length: 10 });
        const result = explorer.getPagingDataResults(cfg, wrapper, 1);
        const r = result[0];
        expect(r).to.be.an('array').with.length(3);
        expect(r[1]).to.equal('txhash123');
        expect(r[2]).to.be.null;
    });
});

describe('method: getSearch', function () {
    it('getSearch with multiple results paginates correctly', function () {
        const rows = Array.from({ length: 15 }, (_, i) => ({ address: `addr${i}` }));
        const wrapper = { data: rows };
        const cfg = makeExplorerConfig('getSearch', null, 'address', { start: 5, length: 5 });
        const result = explorer.getPagingDataResults(cfg, wrapper, 15);
        expect(result).to.have.length(5);
    });

});
