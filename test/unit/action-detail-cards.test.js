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
 * action.html's per-type blocks as detail-card instances (spec M2.5).
 *
 * M2.5 rules that the markup STAYS in the page; what changes is that revealing
 * a block goes through the component, which also applies that type's row
 * config. So the risk here is not a rendering regression - the bytes did not
 * move - it is DRIFT between the config and the markup, and drift in this
 * particular config is dangerous rather than cosmetic: the rows are label/value
 * pairs, so applying a stale order would put values under the wrong labels and
 * produce a page that is plausible and wrong.
 *
 * That is why the config is checked against the page row for row and label for
 * label, and why permuteRows refuses to act on a count mismatch (pinned in
 * component-registry.test.js). Together those mean a config that has fallen out
 * of step fails loudly here, and does nothing at all in a browser.
 *
 * The reveal itself is driven end to end: the shipped showActionDetails is run
 * in a jsdom realm against the shipped action.html.
 *********************************************************************/

'use strict';

const fs     = require('fs');
const path   = require('path');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const ROOT     = path.resolve(__dirname, '..', '..');
const listPage = require(path.join(ROOT, 'src', 'list-page.js'));
const SOURCE   = require('../helpers/content-source.js');
const XCComponents = require(path.join(ROOT, 'src', 'content', 'js', 'components.js'));

const ACTION_HTML = fs.readFileSync(path.join(ROOT, 'src', 'content', 'html', 'action.html'), 'utf8');
const CONFIG = JSON.parse(fs.readFileSync(
    path.join(ROOT, 'src', 'content', 'layouts', 'action-detail-cards.json'), 'utf8'));
const JQUERY = fs.readFileSync(path.join(ROOT, 'src', 'content', 'js', 'jquery.min.js'), 'utf8');

// The per-type blocks as the page actually ships them.
function blocksInPage(){
    const out = {};
    const re = /([ ]*)<div class="d-none" id="info-([a-z_0-9]+)">\n([\s\S]*?)\n\1<\/div>\n/g;
    let m;
    while((m = re.exec(ACTION_HTML))) out[m[2]] = m[3];
    return out;
}

// The label/value rows of one block's FIRST key/value table, which is the part
// the config addresses. A nested datatable (batch, destroy, send) has none.
function rowsInBlock(body){
    const t = /<table class="table table-sm[^"]*" width="100%">\s*\n\s*<tbody>\n([\s\S]*?)\n\s*<\/tbody>\s*\n\s*<\/table>/.exec(body);
    if(!t) return [];
    const rows = [];
    for(const m of t[1].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)){
        const th = /<th\b[^>]*>([\s\S]*?)<\/th>/.exec(m[1]);
        const td = /<td\b([^>]*)>/.exec(m[1]);
        const cls = td ? (/class="([^"]*)"/.exec(td[1]) || [])[1] : undefined;
        rows.push({
            label: th ? th[1].replace(/<[^>]*>/g, '').trim() : '',
            cell:  cls ? cls.split(/\s+/)[0] : null
        });
    }
    return rows;
}

describe('action detail cards (M2.5)', function () {

    const blocks = blocksInPage();
    const cards  = CONFIG.cards;

    it('found the per-type blocks it is asserting about', function () {
        assert.ok(Object.keys(blocks).length >= 30,
            'only ' + Object.keys(blocks).length + ' info-* blocks parsed; the extraction is broken');
    });

    it('gives every block in the page a config entry', function () {
        const missing = Object.keys(blocks).filter((t) => !cards[t]);
        assert.deepEqual(missing, [],
            'per-type blocks with no row config; they mount with no order at all: ' + missing.join(', '));
    });

    it('configures no type the page does not carry', function () {
        const extra = Object.keys(cards).filter((t) => !blocks[t]);
        assert.deepEqual(extra, [],
            'configured types whose block was removed from action.html: ' + extra.join(', '));
    });

    it('matches the page row for row, and label for label, on every type', function () {
        const wrong = [];
        for(const type of Object.keys(blocks)){
            const inPage = rowsInBlock(blocks[type]);
            const inConf = cards[type].rows;
            if(inPage.length !== inConf.length){
                wrong.push(type + ': page has ' + inPage.length + ' rows, config has ' + inConf.length);
                continue;
            }
            for(let i = 0; i < inPage.length; i++){
                if(inPage[i].label !== inConf[i].label || inPage[i].cell !== inConf[i].cell)
                    wrong.push(type + ' row ' + i + ': page '
                        + JSON.stringify(inPage[i]) + ' vs config ' + JSON.stringify(inConf[i]));
            }
        }
        // A mismatch here is not cosmetic. permuteRows would be applying a stale
        // order to real label/value pairs, which relabels data rather than
        // breaking visibly.
        assert.deepEqual(wrong, [], 'config out of step with the shipped markup:\n  ' + wrong.join('\n  '));
    });

    it('leaves a row it cannot address as a placeholder rather than dropping it', function () {
        // A spanning header or a nested control is not a label/value pair. It has
        // to keep its position - it introduces the rows under it - so it is
        // recorded with cell:null instead of being omitted, which would put the
        // config's row count out of step with the page's.
        const unaddressable = [];
        for(const type of Object.keys(cards))
            for(const row of cards[type].rows)
                if(row.cell === null) unaddressable.push(type);
        assert.ok(unaddressable.length > 0, 'the placeholder case is no longer exercised by any block');
        for(const type of new Set(unaddressable))
            assert.equal(cards[type].rows.length, rowsInBlock(blocks[type]).length);
    });

    describe('the config reaches the page', function () {

        it('is spliced into action.html as a JSON block, not fetched', function () {
            assert.match(ACTION_HTML, /\{DATA:action-detail-cards\}/,
                'action.html no longer asks for its row configs');
            const composed = listPage.dataBlocks(ACTION_HTML);
            const block = /id="xc-action-detail-cards">([\s\S]*?)<\/script>/.exec(composed);
            assert.ok(block, 'the data block did not survive composition');
            assert.equal(block[1].includes('<'), false,
                'an unescaped "<" would close the script element early');
            const parsed = JSON.parse(block[1].replace(/\\u003c/g, '<').replace(/\\u003e/g, '>'));
            assert.deepEqual(Object.keys(parsed.cards).sort(), Object.keys(cards).sort());
        });
    });

    describe('showActionDetails, driven', function () {

        function realm(){
            const composed = listPage.dataBlocks(ACTION_HTML);
            const body = composed.slice(0, composed.indexOf('<script'));
            const dom = new JSDOM('<!doctype html><html><body>' + body
                + '<script type="application/json" id="xc-action-detail-cards">'
                + /id="xc-action-detail-cards">([\s\S]*?)<\/script>/.exec(composed)[1]
                + '</script></body></html>', { runScripts: 'outside-only', url: 'https://xchain.test/RDOGE/action/1' });
            const win = dom.window;
            win.numeral = function(v){ return { format: function(){ return String(v); } }; };
            win.eval(JQUERY);
            win.jQuery.fn.ready = function(){ return this; };
            win.eval(fs.readFileSync(path.join(ROOT, 'src', 'content', 'js', 'components.js'), 'utf8'));
            win.eval(SOURCE.clientSource());
            // Register the real detail-card into the realm's registry.
            win.eval(fs.readFileSync(
                path.join(ROOT, 'src', 'content', 'components', 'detail-card', 'init.js'), 'utf8'));
            return win;
        }

        it('registers detail-card in the page realm', function () {
            const win = realm();
            assert.ok(win.XCComponents.get('detail-card'), 'detail-card did not register in the browser realm');
        });

        it('reveals the block for the action being shown, through the component', function () {
            const win = realm();
            assert.equal(win.mountActionDetailCard('broadcast'), true);
            const el = win.document.getElementById('info-broadcast');
            assert.equal(el.classList.contains('d-none'), false, 'the block stayed hidden');
            const mounted = win.XCComponents.mounted();
            assert.equal(mounted[mounted.length - 1].component, 'detail-card');
            assert.equal(mounted[mounted.length - 1].props.type, 'broadcast');
        });

        it('hands the component the row config for that type, not an empty one', function () {
            const win = realm();
            win.mountActionDetailCard('broadcast');
            const mounted = win.XCComponents.mounted();
            const rows = mounted[mounted.length - 1].props.rows;
            // Compared through JSON: the rows were parsed inside the jsdom realm,
            // so they carry that realm's Object prototype and a strict deep
            // comparison fails on identity rather than on content.
            assert.deepEqual(JSON.parse(JSON.stringify(rows)), cards.broadcast.rows);
        });

        it('reveals the block anyway when the component layer is missing', function () {
            // A theme layer that failed to load must never cost a reader the data.
            const win = realm();
            win.XCComponents.reset();
            assert.equal(win.mountActionDetailCard('broadcast'), false);
            assert.equal(win.document.getElementById('info-broadcast').classList.contains('d-none'), false,
                'the fallback did not reveal the block, so the action page renders empty');
        });

        it('does nothing, quietly, for a type the page has no block for', function () {
            const win = realm();
            assert.equal(win.mountActionDetailCard('no-such-action'), false);
        });

        it('parses the embedded config once and caches it', function () {
            const win = realm();
            const first = win.actionDetailCardConfig();
            assert.ok(first && first.broadcast, 'the embedded config did not parse');
            win.document.getElementById('xc-action-detail-cards').remove();
            assert.equal(win.actionDetailCardConfig(), first,
                'the config is re-read on every call; showActionDetails runs more than once per view');
        });

        it('is what showActionDetails calls, rather than a bare removeClass', function () {
            const src = fs.readFileSync(path.join(ROOT, 'src', 'content', 'js', 'xchain.js'), 'utf8');
            const fn = src.slice(src.indexOf('function showActionDetails('),
                                 src.indexOf('function mountActionDetailCard('));
            assert.match(fn, /mountActionDetailCard\(name\)/);
            assert.equal(/\$\('#info-' \+ name\)\.removeClass\('d-none'\)/.test(fn), false,
                'showActionDetails still reveals the block directly, so no card ever mounts');
        });
    });

    describe('the detail-card component itself', function () {

        beforeEach(function () {
            SOURCE.loadComponents(['detail-card']);
        });

        afterEach(function () { delete global.document; });

        it('applies the row order to the block it reveals', function () {
            const dom = new JSDOM('<!doctype html><html><body>'
                + '<div class="d-none" id="info-x"><table><tbody>'
                + '<tr id="r0"><th>A</th><td class="a"></td></tr>'
                + '<tr id="r1"><th>B</th><td class="b"></td></tr>'
                + '<tr id="r2"><th>C</th><td class="c"></td></tr>'
                + '</tbody></table></div></body></html>');
            global.document = dom.window.document;
            const res = XCComponents.mount('info-x', 'detail-card', {
                type: 'x',
                rows: [{ label: 'A', cell: 'a' }, { label: 'B', cell: 'b' }, { label: 'C', cell: 'c', order: 0 }]
            });
            assert.equal(res.ok, true, res.errors.join('; '));
            assert.deepEqual([...dom.window.document.querySelectorAll('#info-x tbody tr')].map((r) => r.id),
                ['r2', 'r0', 'r1']);
            assert.equal(dom.window.document.getElementById('info-x').classList.contains('d-none'), false);
        });

        it('can be mounted without revealing, for a theme that controls visibility itself', function () {
            const dom = new JSDOM('<!doctype html><html><body>'
                + '<div class="d-none" id="info-x"><table><tbody></tbody></table></div></body></html>');
            global.document = dom.window.document;
            XCComponents.mount('info-x', 'detail-card', { type: 'x', rows: [], reveal: false });
            assert.equal(dom.window.document.getElementById('info-x').classList.contains('d-none'), true);
        });
    });
});
