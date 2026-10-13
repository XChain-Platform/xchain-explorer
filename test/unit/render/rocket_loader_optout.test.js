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
 * Every script tag a rendered page carries opts out of Cloudflare Rocket
 * Loader, which otherwise holds and re-sequences the explorer's scripts.
 */

'use strict';

const assert = require('assert');
const { optOutOfRocketLoader } = require('../../../src/render/rocket_loader_optout.js');
const { makeExplorer, request } = require('../explorer/routes/explorer_routing.test/support/helpers.js');

describe('Rocket Loader opt-out', function(){
    it('marks external, deferred and inline script tags', function(){
        const out = optOutOfRocketLoader('<script src="/js/a.js"></script><script defer src="/js/b.js"></script><script>x()</script><SCRIPT type="text/javascript">y()</SCRIPT>');
        assert.strictEqual(out.match(/data-cfasync="false"/g).length, 4);
        assert.ok(out.includes('<script data-cfasync="false" src="/js/a.js">'));
    });

    it('leaves a tag that already names data-cfasync and anything that is not a script tag', function(){
        const html = '<script data-cfasync="true" src="/x.js"></script><noscript>n</noscript><p>script</p>';
        assert.strictEqual(optOutOfRocketLoader(html), html);
    });

    it('reaches every script tag on a rendered list page and a rendered detail page', async function(){
        const explorer = makeExplorer();
        for(const path of ['/BTC/blocks', '/BTC/address/1XChain3M4uRwcHqt4XuhVBUQ8cL4qQsA']){
            const { res } = await request(explorer, path);
            const html = String(res._body || '');
            const tags = html.match(/<script\b[^>]*>/gi) || [];
            assert.ok(tags.length > 5, path + ' rendered ' + tags.length + ' script tags');
            const unmarked = tags.filter((t) => !/data-cfasync="false"/.test(t));
            assert.deepStrictEqual(unmarked, [], path);
        }
    });
});
