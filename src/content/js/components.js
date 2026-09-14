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
 * components.js
 *
 * The component registry and the client runtime that mounts from a manifest
 * (spec M2.1). Zero-build by ruling: this is a plain script, a component's
 * init.js is a plain script, and nothing here compiles or imports anything.
 *
 * The shape of a page under this system is: the server stitches markup that
 * carries mount points, and ends with ONE JSON block naming what to mount on
 * them. The runtime reads that block and calls each component's mount function.
 * The manifest is DATA, never code: it ships as <script type="application/json">
 * so the Content-Security-Policy that already forbids inline script does not
 * have to be widened, which is the whole reason a JSON block was chosen over
 * an inline call.
 *
 * Props are validated against the component's declared prop table before mount.
 * The point is not type safety for its own sake: a theme author writing a
 * layout by hand is the expected caller, and an unvalidated typo'd prop mounts
 * a component that renders an empty box, which reads as missing data rather
 * than as a mistake. A validation failure is therefore loud AND visible: it
 * logs, and it leaves a message in the mount point instead of nothing.
 */

'use strict';

// Top level, so the page's browser_logger.js global is used when it is loaded first;
// the unit suites require this file under Node and fall back to the module.
var XCLogger = (typeof XCLogger !== 'undefined' && XCLogger) ? XCLogger
    : ((typeof require === 'function') ? require('./browser_logger.js') : null);

    // name -> { props, mount, name }
    var xcComponentsRegistry = {};

    // Every mount that has run, in order, so a test (and a theme's custom.js)
    // can see what a page actually put on the screen.
    var xcComponentsMounted = [];

    // The prop types a component.json may declare. Deliberately few: a prop is
    // either a scalar the template substitutes, a list the component iterates,
    // or a bag it passes through. Anything richer belongs in the component.
    var xcComponentsTypes = {
        string:  function(v){ return typeof v === 'string'; },
        number:  function(v){ return typeof v === 'number' && isFinite(v); },
        boolean: function(v){ return typeof v === 'boolean'; },
        array:   function(v){ return Array.isArray(v); },
        object:  function(v){ return v !== null && typeof v === 'object' && !Array.isArray(v); }
    };

    function xcComponentsIsBlank(v){
        return v === null || v === undefined || v === '';
    }

    /**
     * Register a component.
     *
     * @param {string} name  the name a manifest entry and a layout use
     * @param {object} def   { props: {<prop>: {type, required, default}}, mount: fn(el, props, ctx) }
     */
    function xcComponentsRegister(name, def){
        if(typeof name !== 'string' || name === '')
            throw new Error('XCComponents.register: a component needs a name');
        if(!def || typeof def.mount !== 'function')
            throw new Error('XCComponents.register: ' + name + ' has no mount function');
        // A second registration under one name is how a theme overrides a
        // component, so it is allowed - but it is never silent, because the
        // other way it happens is two files fighting over one name.
        if(xcComponentsRegistry[name])
            XCLogger.info('XCComponents: ' + name + ' re-registered (theme override, or a name collision)');
        xcComponentsRegistry[name] = { name: name, props: def.props || {}, mount: def.mount };
        return xcComponentsRegistry[name];
    }

    function xcComponentsGet(name){
        return Object.prototype.hasOwnProperty.call(xcComponentsRegistry, name) ? xcComponentsRegistry[name] : null;
    }

    function xcComponentsNames(){
        return Object.keys(xcComponentsRegistry).sort();
    }

    // Test/hot-reload seam. Not called by the runtime.
    function xcComponentsReset(){
        xcComponentsRegistry = {};
        xcComponentsMounted  = [];
    }

    /**
     * Check props against a component's declared prop table, filling defaults.
     *
     * Returns { ok, errors: [string], props }. `props` is a NEW object: defaults
     * are filled in there rather than mutated into the caller's manifest, so the
     * manifest a page shipped stays readable as what the page asked for.
     *
     * An UNDECLARED prop is an error, not a pass-through. A theme that mounts
     * data-table with `column` instead of `columns` would otherwise get the
     * component's default columns and no indication anything was ignored.
     */
    function xcComponentsValidate(name, props){
        var def = xcComponentsGet(name);
        var errors = [];
        if(!def)
            return { ok: false, errors: ['no component registered as ' + JSON.stringify(name)], props: {} };
        var input = (props && typeof props === 'object') ? props : {};
        var out = {};
        var key;
        for(key in def.props){
            if(!Object.prototype.hasOwnProperty.call(def.props, key)) continue;
            var spec  = def.props[key] || {};
            var value = Object.prototype.hasOwnProperty.call(input, key) ? input[key] : undefined;
            if(value === undefined && spec.default !== undefined)
                value = spec.default;
            if(xcComponentsIsBlank(value) && spec.required){
                errors.push(name + '.' + key + ' is required');
                continue;
            }
            // A blank OPTIONAL prop is "not supplied", not a wrong type: a
            // layout writes query: null to mean an unfiltered list, and type
            // checking that null against 'string' would reject the common case.
            if(value !== undefined && spec.type && !xcComponentsIsBlank(value)){
                var check = xcComponentsTypes[spec.type];
                if(!check)
                    errors.push(name + '.' + key + ' declares unknown type ' + JSON.stringify(spec.type));
                else if(!check(value))
                    errors.push(name + '.' + key + ' must be a ' + spec.type);
            }
            if(value !== undefined)
                out[key] = value;
        }
        for(key in input){
            if(!Object.prototype.hasOwnProperty.call(input, key)) continue;
            if(!Object.prototype.hasOwnProperty.call(def.props, key))
                errors.push(name + ' has no prop named ' + JSON.stringify(key));
        }
        return { ok: errors.length === 0, errors: errors, props: out };
    }

    /**
     * Mount one component into one element.
     *
     * @param {Element|string} target  an element, or a selector/id resolved against the document
     * @param {string} name            registered component name
     * @param {object} props           instance props, validated first
     * @param {object} ctx             ambient context handed to every mount (coin, network, theme)
     * @returns {object} { ok, errors, result }
     */
    function xcComponentsMount(target, name, props, ctx){
        var el = xcComponentsResolve(target);
        var def = xcComponentsGet(name);
        if(!def){
            xcComponentsFail(el, 'Unknown component: ' + name);
            return { ok: false, errors: ['no component registered as ' + JSON.stringify(name)], result: null };
        }
        if(!el){
            var miss = name + ': mount point ' + JSON.stringify(String(target)) + ' is not on the page';
            XCLogger.error('XCComponents: ' + miss);
            return { ok: false, errors: [miss], result: null };
        }
        var check = xcComponentsValidate(name, props);
        if(!check.ok){
            xcComponentsFail(el, name + ': ' + check.errors.join('; '));
            return { ok: false, errors: check.errors, result: null };
        }
        var result;
        try {
            result = def.mount(el, check.props, ctx || xcComponentsContext());
        } catch(e){
            var msg = name + ' failed to mount: ' + (e && e.message ? e.message : String(e));
            xcComponentsFail(el, msg);
            return { ok: false, errors: [msg], result: null };
        }
        xcComponentsMounted.push({ component: name, el: el, props: check.props });
        return { ok: true, errors: [], result: result };
    }

    // A failed mount says so where the component would have been. Silence here
    // is indistinguishable from a surface that legitimately has no rows.
    function xcComponentsFail(el, message){
        XCLogger.error('XCComponents: ' + message);
        if(el && typeof el.setAttribute === 'function'){
            el.setAttribute('data-xc-mount-error', message);
            if(el.ownerDocument){
                var box = el.ownerDocument.createElement('div');
                box.className = 'alert alert-warning small mb-0';
                box.textContent = message;
                el.appendChild(box);
            }
        }
    }

    function xcComponentsResolve(target){
        if(!target) return null;
        if(typeof target !== 'string') return target;
        if(typeof document === 'undefined') return null;
        if(target.charAt(0) === '#' || target.charAt(0) === '.' || target.indexOf('[') === 0)
            return document.querySelector(target);
        return document.getElementById(target);
    }

    // The ambient facts every component gets. Read from XC when the page
    // controller has set it up, defaulted otherwise so a component is
    // mountable in a test without the whole page namespace.
    function xcComponentsContext(extra){
        var xc = (typeof XC !== 'undefined' && XC) ? XC : {};
        var ctx = {
            coin:    xc.coin    || null,
            network: xc.network || null,
            name:    xc.name    || null,
            theme:   'classic'
        };
        if(typeof document !== 'undefined' && document.documentElement){
            var t = document.documentElement.getAttribute('data-xc-theme');
            if(t) ctx.theme = t;
        }
        if(extra){
            for(var k in extra)
                if(Object.prototype.hasOwnProperty.call(extra, k)) ctx[k] = extra[k];
        }
        return ctx;
    }

    /**
     * Read a page's mount manifest and mount everything in it.
     *
     * The manifest is a JSON array of { el, component, props }. `el` is the id
     * (or selector) of the mount point. Order is the page's, not the DOM's:
     * a composed page lists its regions in the order the composer stitched them.
     *
     * @param {Document|Element} root  defaults to document
     * @param {string} id              manifest script element id
     */
    function xcComponentsMountManifest(root, id){
        var doc = root || (typeof document !== 'undefined' ? document : null);
        if(!doc) return [];
        var node = (typeof doc.querySelector === 'function')
            ? doc.querySelector('#' + (id || 'xc-mount-manifest'))
            : null;
        if(!node) return [];
        var manifest;
        try {
            manifest = JSON.parse(node.textContent || '[]');
        } catch(e){
            XCLogger.error('XCComponents: mount manifest is not valid JSON: ' + (e && e.message));
            return [];
        }
        return xcComponentsMountAll(manifest);
    }

    function xcComponentsMountAll(manifest){
        var out = [];
        if(!Array.isArray(manifest)) return out;
        var ctx = xcComponentsContext();
        for(var i = 0; i < manifest.length; i++){
            var entry = manifest[i] || {};
            out.push(xcComponentsMount(entry.el, entry.component, entry.props, ctx));
        }
        return out;
    }

    /**
     * Resolve a config list into the order its items are rendered in.
     *
     * Shared by every component whose config is a list a theme may resequence:
     * the data-table's columns, the detail-card's rows, the tab-panel's tabs.
     * `hidden` drops an item; `order` places it. Items without an `order` keep
     * their array order, and the placed ones are inserted among them.
     *
     * The ARRAY order is canonical and stays that way, because for a data-table
     * it is also the feed's field order. This returns render-position ->
     * canonical-index, so nothing has to renumber anything.
     */
    function xcComponentsResolveOrder(items){
        var list = [];
        var i;
        if(!Array.isArray(items)) return list;
        for(i = 0; i < items.length; i++)
            if(!(items[i] && items[i].hidden)) list.push(i);
        var placed = list.filter(function(i){ return typeof items[i].order === 'number'; });
        if(placed.length === 0) return list;
        var rest = list.filter(function(i){ return typeof items[i].order !== 'number'; });
        placed.sort(function(a, b){ return items[a].order - items[b].order; });
        var out = rest.slice();
        for(i = 0; i < placed.length; i++){
            var at = Math.max(0, Math.min(out.length, items[placed[i]].order));
            out.splice(at, 0, placed[i]);
        }
        return out;
    }

    /**
     * Apply a row config to a <tbody>: reorder its rows, drop the hidden ones.
     *
     * Detaching and re-appending rather than swapping in place, because a swap
     * loop over a live NodeList reads positions it has already changed. A row
     * count that does not match the config is left ALONE rather than
     * best-effort permuted: the mismatch means the page's markup and the config
     * have drifted, and reordering rows under that assumption would relabel
     * data, which is worse than doing nothing.
     */
    function xcComponentsPermuteRows(tbody, config){
        if(!tbody || !Array.isArray(config)) return false;
        var rows = [];
        for(var i = 0; i < tbody.children.length; i++)
            if(tbody.children[i].tagName === 'TR') rows.push(tbody.children[i]);
        if(rows.length !== config.length){
            XCLogger.warn('XCComponents: row config has ' + config.length
                + ' entries but the table has ' + rows.length + ' rows; leaving it alone');
            return false;
        }
        var order = xcComponentsResolveOrder(config);
        var same = order.length === rows.length;
        if(same){
            for(i = 0; i < order.length; i++) if(order[i] !== i){ same = false; break; }
        }
        if(same) return false;
        for(i = 0; i < rows.length; i++)
            if(rows[i].parentNode === tbody) tbody.removeChild(rows[i]);
        for(i = 0; i < order.length; i++)
            if(rows[order[i]]) tbody.appendChild(rows[order[i]]);
        return true;
    }

function xcComponentsCreate(){
    return {
        register: xcComponentsRegister,
        resolveOrder: xcComponentsResolveOrder,
        permuteRows: xcComponentsPermuteRows,
        get: xcComponentsGet,
        names: xcComponentsNames,
        reset: xcComponentsReset,
        validate: xcComponentsValidate,
        mount: xcComponentsMount,
        mountAll: xcComponentsMountAll,
        mountManifest: xcComponentsMountManifest,
        context: xcComponentsContext,
        mounted: function(){ return xcComponentsMounted.slice(); }
    };
}

var XCComponents = xcComponentsCreate();
if(typeof window !== 'undefined') window.XCComponents = XCComponents;

// Deliberately NOT auto-mounted on jQuery's ready event. This file loads before
// xchain.js, so its ready handler would run before initPage() has called
// setXChainParams(), and every component would mount with XC.coin still null -
// a table that quietly requests /null/explorer/... and renders empty. xchain.js
// calls XCComponents.mountManifest() at the end of its own ready handler
// instead, which is the first moment the ambient context is real.

if(typeof module !== 'undefined' && module.exports)
    module.exports = XCComponents;
