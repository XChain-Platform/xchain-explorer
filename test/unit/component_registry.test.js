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
 * The component registry and runtime (spec M2.1).
 *
 * Everything here drives the SHIPPED src/content/js/components.js, required
 * as a module, so a divergence between what the browser loads and what is
 * asserted is not possible.
 *
 * The failures this exists to catch, in the order they would actually happen:
 *
 *  - a props typo mounting a component that renders nothing, which a reader
 *    cannot tell from a surface that legitimately has no data;
 *  - a mount that throws taking the page down with it, or worse, failing
 *    silently and leaving a blank card;
 *  - the ordering contract (`hidden`/`order`) drifting between the three
 *    components that share it, which would put a theme's columns and its
 *    headers out of step - the one bug in this layer that relabels data;
 *  - components.js mounting on jQuery's ready event, which would run every
 *    mount before initPage() has resolved XC.coin. That is the trap that
 *    motivated the explicit call from xchain.js, and nothing but a test keeps
 *    someone from "fixing" it back.
 *********************************************************************/

'use strict';

const fs     = require('fs');
const path   = require('path');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const ROOT       = path.resolve(__dirname, '..', '..');
const COMPONENTS = path.join(ROOT, 'src', 'content', 'js', 'components.js');
const XCComponents = require(COMPONENTS);

// A document to hang mount points on. Fresh per test so an error box left by
// one case cannot be read as another's.
function domWith(html){
    const dom = new JSDOM('<!doctype html><html><body>' + (html || '') + '</body></html>');
    global.document = dom.window.document;
    return dom;
}

function noopMount(){ return 'mounted'; }

describe('component registry and runtime (M2.1)', function () {

    beforeEach(function () {
        XCComponents.reset();
    });

    afterEach(function () {
        delete global.document;
    });

    describe('register', function () {

        it('registers a component and lists it by name', function () {
            XCComponents.register('thing', { mount: noopMount });
            assert.deepEqual(XCComponents.names(), ['thing']);
            assert.equal(XCComponents.get('thing').name, 'thing');
        });

        it('refuses a component with no mount function, rather than failing at mount time', function () {
            assert.throws(() => XCComponents.register('thing', {}), /no mount function/);
            assert.throws(() => XCComponents.register('', { mount: noopMount }), /needs a name/);
        });

        it('get() answers null for an unregistered name, never a prototype member', function () {
            // A plain-object registry answers `get('constructor')` with Object's
            // constructor unless lookups are guarded, and a caller that trusts a
            // truthy answer would then call it as a component.
            assert.equal(XCComponents.get('constructor'), null);
            assert.equal(XCComponents.get('toString'), null);
            assert.equal(XCComponents.get('nope'), null);
        });
    });

    describe('validate', function () {

        beforeEach(function () {
            XCComponents.register('widget', {
                props: {
                    id:      { type: 'string',  required: true },
                    rows:    { type: 'array' },
                    size:    { type: 'number',  default: 10 },
                    open:    { type: 'boolean', default: true },
                    query:   { type: 'string' }
                },
                mount: noopMount
            });
        });

        it('fills declared defaults without touching the caller object', function () {
            const input = { id: 'a' };
            const out = XCComponents.validate('widget', input);
            assert.equal(out.ok, true);
            assert.equal(out.props.size, 10);
            assert.equal(out.props.open, true);
            assert.deepEqual(input, { id: 'a' }, 'the manifest the page shipped was mutated');
        });

        it('names a missing required prop', function () {
            const out = XCComponents.validate('widget', { rows: [] });
            assert.equal(out.ok, false);
            assert.deepEqual(out.errors, ['widget.id is required']);
        });

        it('names a wrong type, with the type it wanted', function () {
            const out = XCComponents.validate('widget', { id: 'a', rows: 'not-an-array' });
            assert.equal(out.ok, false);
            assert.deepEqual(out.errors, ['widget.rows must be a array']);
        });

        it('rejects an UNDECLARED prop instead of ignoring it', function () {
            // The whole point: `column` for `columns` would otherwise mount with
            // the component's defaults and no sign anything was dropped.
            const out = XCComponents.validate('widget', { id: 'a', column: [] });
            assert.equal(out.ok, false);
            assert.deepEqual(out.errors, ['widget has no prop named "column"']);
        });

        it('treats a blank OPTIONAL prop as absent, not as the wrong type', function () {
            // A layout writes query: null for an unfiltered list; type-checking
            // that null against 'string' would reject the ordinary case.
            const out = XCComponents.validate('widget', { id: 'a', query: null });
            assert.equal(out.ok, true, out.errors.join('; '));
        });

        it('reports an unknown component rather than throwing', function () {
            const out = XCComponents.validate('ghost', {});
            assert.equal(out.ok, false);
            assert.match(out.errors[0], /no component registered as "ghost"/);
        });
    });

    describe('mount', function () {

        it('mounts into an element resolved by id and records it', function () {
            const dom = domWith('<div id="slot"></div>');
            XCComponents.register('thing', { props: {}, mount: noopMount });
            const res = XCComponents.mount('slot', 'thing', {});
            assert.equal(res.ok, true);
            assert.equal(res.result, 'mounted');
            assert.equal(XCComponents.mounted().length, 1);
            assert.equal(XCComponents.mounted()[0].el, dom.window.document.getElementById('slot'));
        });

        it('says so IN the mount point when props do not validate', function () {
            const dom = domWith('<div id="slot"></div>');
            XCComponents.register('thing', { props: { id: { type: 'string', required: true } }, mount: noopMount });
            const res = XCComponents.mount('slot', 'thing', {});
            assert.equal(res.ok, false);
            const el = dom.window.document.getElementById('slot');
            assert.match(el.getAttribute('data-xc-mount-error'), /thing\.id is required/);
            assert.match(el.textContent, /thing\.id is required/,
                'a failed mount must be visible; silence reads as "this surface has no data"');
            assert.equal(XCComponents.mounted().length, 0);
        });

        it('catches a throwing mount and reports it, leaving the page up', function () {
            const dom = domWith('<div id="slot"></div>');
            XCComponents.register('thing', { props: {}, mount: function(){ throw new Error('kaboom'); } });
            const res = XCComponents.mount('slot', 'thing', {});
            assert.equal(res.ok, false);
            assert.match(res.errors[0], /thing failed to mount: kaboom/);
            assert.match(dom.window.document.getElementById('slot').textContent, /kaboom/);
        });

        it('reports a mount point that is not on the page without inventing one', function () {
            domWith('');
            XCComponents.register('thing', { props: {}, mount: noopMount });
            const res = XCComponents.mount('missing', 'thing', {});
            assert.equal(res.ok, false);
            assert.match(res.errors[0], /is not on the page/);
        });
    });

    describe('mountManifest', function () {

        it('mounts every entry, in manifest order', function () {
            const dom = domWith(
                '<div id="a"></div><div id="b"></div>'
                + '<script type="application/json" id="xc-mount-manifest">'
                + JSON.stringify([
                    { el: 'b', component: 'thing', props: { tag: 'second' } },
                    { el: 'a', component: 'thing', props: { tag: 'first'  } }
                ])
                + '</script>');
            const seen = [];
            XCComponents.register('thing', {
                props: { tag: { type: 'string' } },
                mount: function(el, props){ seen.push(props.tag); }
            });
            XCComponents.mountManifest(dom.window.document);
            assert.deepEqual(seen, ['second', 'first'],
                'the manifest order is the page composition order, not the DOM order');
        });

        it('is loud, and mounts nothing, when the manifest is not valid JSON', function () {
            const dom = domWith('<script type="application/json" id="xc-mount-manifest">{oops</script>');
            const errors = [];
            const realError = console.error;
            console.error = (m) => errors.push(String(m));
            try {
                const out = XCComponents.mountManifest(dom.window.document);
                assert.deepEqual(out, []);
            } finally {
                console.error = realError;
            }
            assert.equal(errors.length, 1);
            assert.match(errors[0], /mount manifest is not valid JSON/);
        });

        it('does nothing at all on a page with no manifest', function () {
            const dom = domWith('<div id="a"></div>');
            assert.deepEqual(XCComponents.mountManifest(dom.window.document), []);
        });
    });

    describe('resolveOrder and permuteRows: the ordering contract three components share', function () {

        it('keeps array order when the config asks for nothing', function () {
            assert.deepEqual(XCComponents.resolveOrder([{}, {}, {}]), [0, 1, 2]);
        });

        it('drops hidden items and keeps the rest in array order', function () {
            assert.deepEqual(XCComponents.resolveOrder([{}, { hidden: true }, {}]), [0, 2]);
        });

        it('places an ordered item at its index among the unordered ones', function () {
            assert.deepEqual(
                XCComponents.resolveOrder([{ label: 'a' }, { label: 'b' }, { label: 'c', order: 0 }]),
                [2, 0, 1]);
        });

        it('clamps an out-of-range order instead of leaving a hole', function () {
            assert.deepEqual(
                XCComponents.resolveOrder([{ label: 'a' }, { label: 'b', order: 99 }]),
                [0, 1]);
            assert.deepEqual(
                XCComponents.resolveOrder([{ label: 'a' }, { label: 'b', order: -5 }]),
                [1, 0]);
        });

        it('returns an empty order for a non-array, rather than throwing at mount', function () {
            assert.deepEqual(XCComponents.resolveOrder(undefined), []);
            assert.deepEqual(XCComponents.resolveOrder(null), []);
        });

        it('reorders a tbody to match the config', function () {
            const dom = domWith('<table><tbody id="b">'
                + '<tr id="r0"><th>A</th><td>1</td></tr>'
                + '<tr id="r1"><th>B</th><td>2</td></tr>'
                + '<tr id="r2"><th>C</th><td>3</td></tr>'
                + '</tbody></table>');
            const tbody = dom.window.document.getElementById('b');
            const moved = XCComponents.permuteRows(tbody, [{}, {}, { order: 0 }]);
            assert.equal(moved, true);
            assert.deepEqual([...tbody.children].map((r) => r.id), ['r2', 'r0', 'r1']);
        });

        it('drops a hidden row from the DOM', function () {
            const dom = domWith('<table><tbody id="b">'
                + '<tr id="r0"><th>A</th><td>1</td></tr>'
                + '<tr id="r1"><th>B</th><td>2</td></tr>'
                + '</tbody></table>');
            const tbody = dom.window.document.getElementById('b');
            XCComponents.permuteRows(tbody, [{ hidden: true }, {}]);
            assert.deepEqual([...tbody.children].map((r) => r.id), ['r1']);
        });

        it('LEAVES THE TABLE ALONE when the config and the markup disagree on row count', function () {
            // The dangerous case. If the page grew a row the config does not know
            // about, permuting on the config's indexes moves values under the
            // wrong labels - data that reads as true and is not. Doing nothing is
            // the only safe answer, and it warns so the drift gets fixed.
            const dom = domWith('<table><tbody id="b">'
                + '<tr id="r0"><th>A</th><td>1</td></tr>'
                + '<tr id="r1"><th>B</th><td>2</td></tr>'
                + '<tr id="r2"><th>C</th><td>3</td></tr>'
                + '</tbody></table>');
            const tbody = dom.window.document.getElementById('b');
            const warnings = [];
            const realWarn = console.warn;
            console.warn = (m) => warnings.push(String(m));
            let moved;
            try {
                moved = XCComponents.permuteRows(tbody, [{ order: 0 }, {}]);
            } finally {
                console.warn = realWarn;
            }
            assert.equal(moved, false);
            assert.deepEqual([...tbody.children].map((r) => r.id), ['r0', 'r1', 'r2']);
            assert.match(warnings[0], /row config has 2 entries but the table has 3 rows/);
        });

        it('does not touch the DOM when the config is the identity order', function () {
            const dom = domWith('<table><tbody id="b">'
                + '<tr id="r0"><th>A</th><td>1</td></tr>'
                + '<tr id="r1"><th>B</th><td>2</td></tr>'
                + '</tbody></table>');
            const tbody = dom.window.document.getElementById('b');
            assert.equal(XCComponents.permuteRows(tbody, [{}, {}]), false);
            assert.deepEqual([...tbody.children].map((r) => r.id), ['r0', 'r1']);
        });
    });

    describe('load-order contract with xchain.js', function () {

        const SRC     = fs.readFileSync(COMPONENTS, 'utf8');
        const CLIENT  = fs.readFileSync(path.join(ROOT, 'src', 'content', 'js', 'xchain.js'), 'utf8');
        const SHELL   = fs.readFileSync(path.join(ROOT, 'src', 'content', 'html', 'template.html'), 'utf8');

        it('components.js does NOT mount on jQuery ready', function () {
            // It loads before xchain.js, so a ready handler here would fire before
            // initPage() has run setXChainParams() and every component would mount
            // with XC.coin still null - a table quietly requesting /null/explorer.
            assert.equal(/jQuery\(function\(/.test(SRC), false,
                'components.js registered a jQuery ready handler; mounting there runs '
                + 'before initPage() resolves the coin context');
        });

        it('xchain.js mounts the manifest from its own ready handler', function () {
            assert.match(CLIENT, /XCComponents\.mountManifest\(\)/,
                'nothing calls mountManifest, so a composed page mounts nothing at all');
            const ready = CLIENT.slice(CLIENT.lastIndexOf('$(document).ready(function(){'));
            assert.ok(ready.indexOf('initPage();') < ready.indexOf('XCComponents.mountManifest()'),
                'mountManifest must run AFTER initPage(), which is what resolves XC.coin');
        });

        it('the shell loads formatters.js and components.js before xchain.js', function () {
            const at = (f) => SHELL.indexOf('src="/js/' + f + '"');
            assert.ok(at('formatters.js') > -1 && at('components.js') > -1 && at('xchain.js') > -1);
            assert.ok(at('formatters.js') < at('xchain.js'), 'formatters.js must load before xchain.js');
            assert.ok(at('components.js') < at('xchain.js'), 'components.js must load before xchain.js');
        });
    });
});
