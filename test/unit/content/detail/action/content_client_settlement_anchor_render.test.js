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
 *********************************************************************/

'use strict';

const fs = require('fs');
const path = require('path');
const { expect } = require('chai');
const { JSDOM } = require('jsdom');

const content = path.resolve(__dirname, '..', '..', '..', '../../src/content');
const panels = require(path.join(content, 'js', 'xbridge_panels_render.js'));
const bridgeSql = require(path.resolve(content, '..', 'db', 'action_detail', 'xbridge_sql.js'));

// Name every field a snapshot query returns: its alias, or the bare column.
function selectedFields(sql){
    const list = sql.slice(sql.indexOf('SELECT') + 6, sql.lastIndexOf(' FROM '));
    return list.split(/,(?![^(]*\))/).map((col) => {
        const alias = col.match(/\bAS\s+([A-Za-z_]+)\s*$/i);
        return alias ? alias[1] : col.trim();
    });
}

// Build a fixture from the row the handler really returns, never a hand-made shape.
function snapshotRow(sql, row){
    const fields = selectedFields(sql);
    for(const key of Object.keys(row)) expect(fields, 'the query selects ' + key).to.include(key);
    return row;
}

function feedLabel(action){
    const dom = new JSDOM('<!DOCTYPE html><body></body>', { runScripts: 'outside-only' });
    dom.window.XC = { coin: 'DOGE' };
    dom.window.eval(fs.readFileSync(path.join(content, 'js', 'xchain', 'action_detail.js'), 'utf8'));
    return dom.window.getActionDetails(action, {});
}

describe('settlement anchor panels', function(){
    it('renders an XPOLICY snapshot', function(){
        const html = panels.renderXpolicyAction({ policy_snapshot: snapshotRow(bridgeSql.POLICY_SNAPSHOT, {
            tick: 'PEPE', origin_chain: 'BTC', policy_seq: 3, snapshot_block: 900, origin_block: 880,
            allow_count: 2, block_count: null, sleeping: 1, policy_hash: 'ab12'
        })});
        expect(html).to.contain('data-anchor="xpolicy"');
        expect(html).to.contain('PEPE');
        expect(html).to.match(/xc-anchor-allow-list">2 addresses/);
        expect(html).to.match(/xc-anchor-sleeping">yes/);
        expect(html).to.match(/xc-anchor-block-list">none/);
    });

    it('tells an empty XPOLICY list from no list', function(){
        const html = panels.renderXpolicyAction({ policy_snapshot: snapshotRow(bridgeSql.POLICY_SNAPSHOT, {
            allow_count: 0, block_count: 5, sleeping: 0
        })});
        expect(html).to.match(/xc-anchor-allow-list">0 addresses/);
        expect(html).to.match(/xc-anchor-block-list">5 addresses/);
        expect(html).to.match(/xc-anchor-sleeping">no/);
    });

    it('renders a LIST_SHARE version and escapes the name', function(){
        const html = panels.renderListShareAction({ list_snapshot: snapshotRow(bridgeSql.LIST_SNAPSHOT, {
            home_chain: 'DOGE', home_list_index: 7, seq: 2, kind: 'delta', snapshot_block: 910,
            added_count: 1, removed_count: 0, name: '<b>n</b>', members_hash: 'cd34'
        })});
        expect(html).to.contain('data-anchor="list-share"');
        expect(html).to.contain('2 (delta)');
        expect(html).to.match(/xc-anchor-added">1</);
        expect(html).to.match(/xc-anchor-removed">0</);
        expect(html).to.contain('&lt;b&gt;n&lt;/b&gt;');
        expect(html).to.not.contain('<b>n</b>');
    });

    it('shows dashes when the snapshot is not mirrored', function(){
        const policy = panels.renderXpolicyAction({});
        expect(policy).to.match(/xc-anchor-token">-/);
        expect(policy).to.match(/xc-anchor-allow-list">-/);
        expect(policy).to.match(/xc-anchor-block-list">-/);
        expect(policy).to.match(/xc-anchor-sleeping">-/);
        const list = panels.renderListShareAction({});
        expect(list).to.match(/xc-anchor-added">-/);
        expect(list).to.match(/xc-anchor-removed">-/);
    });

    it('labels XPOLICY and LIST_SHARE rows in compact action feeds', function(){
        expect(feedLabel('XPOLICY')).to.equal('Policy snapshot (XPOLICY)');
        expect(feedLabel('LIST_SHARE')).to.equal('Shared list version (LIST_SHARE)');
    });

    it('wires both actions into the action page', function(){
        const markup = fs.readFileSync(path.join(content, 'html', 'action.html'), 'utf8');
        const core = fs.readFileSync(path.join(content, 'js', 'xchain', 'detail', 'detail_core.js'), 'utf8');
        const doc = new JSDOM(markup).window.document;
        expect(doc.getElementById('info-xpolicy')).to.not.equal(null);
        expect(doc.getElementById('info-list-share')).to.not.equal(null);
        expect(core).to.contain("o.action=='XPOLICY'");
        expect(core).to.contain("o.action=='LIST_SHARE'");
    });
});
