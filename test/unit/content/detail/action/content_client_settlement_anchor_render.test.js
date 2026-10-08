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

function feedLabel(action){
    const dom = new JSDOM('<!DOCTYPE html><body></body>', { runScripts: 'outside-only' });
    dom.window.XC = { coin: 'DOGE' };
    dom.window.eval(fs.readFileSync(path.join(content, 'js', 'xchain', 'action_detail.js'), 'utf8'));
    return dom.window.getActionDetails(action, {});
}

describe('settlement anchor panels', function(){
    it('renders an XPOLICY snapshot', function(){
        const html = panels.renderXpolicyAction({ policy_snapshot: {
            tick: 'PEPE', origin_chain: 'BTC', policy_seq: 3, snapshot_block: 900, origin_block: 880,
            allow_list: '["a","b"]', block_list: null, sleeping: 1, policy_hash: 'ab12'
        }});
        expect(html).to.contain('data-anchor="xpolicy"');
        expect(html).to.contain('PEPE');
        expect(html).to.contain('2 addresses');
        expect(html).to.match(/xc-anchor-sleeping">yes/);
        expect(html).to.match(/xc-anchor-block-list">none/);
    });

    it('renders a LIST_SHARE version and escapes the name', function(){
        const html = panels.renderListShareAction({ list_snapshot: {
            home_chain: 'DOGE', home_list_index: 7, seq: 2, kind: 'delta', snapshot_block: 910,
            added: '["x"]', removed: '[]', name: '<b>n</b>', members_hash: 'cd34'
        }});
        expect(html).to.contain('data-anchor="list-share"');
        expect(html).to.contain('2 (delta)');
        expect(html).to.contain('&lt;b&gt;n&lt;/b&gt;');
        expect(html).to.not.contain('<b>n</b>');
    });

    it('shows dashes when the snapshot is not mirrored', function(){
        expect(panels.renderXpolicyAction({})).to.match(/xc-anchor-token">-/);
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
