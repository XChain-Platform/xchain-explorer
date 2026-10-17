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
 * Static scan of the browser scripts' globals.
 *
 * Every first-party script is a plain browser file sharing one global scope,
 * so "page P needs script S" means some code P runs names a global S
 * declares. This parses a script with acorn and reports what it declares and
 * what it reads, as tokens:
 *
 *   id:NAME          a free identifier
 *   .NAME            a call to a jQuery plugin method (`$(el).dataTable()`)
 *   @ATTR            an attribute a plugin scans the DOM for
 *   component:NAME   a component mounted or looked up by name
 *
 * A read inside `typeof` is a guard, not a read, and is skipped.
 *********************************************************************/

'use strict';

const acorn = require('acorn');

// Plugin methods and DOM attributes that tie code to a library with no global
// name of its own.
const PLUGIN_MEMBERS = new Set(['DataTable', 'dataTable', 'qrcode', 'livestamp', 'throttle', 'debounce']);
const PLUGIN_ATTRS   = ['data-livestamp'];

// XCComponents methods that name a component, and which argument holds the name.
const COMPONENT_CALLS = { mount: 1, get: 0 };

const FUNCTION_TYPES = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);
const SKIP_KEYS = new Set(['type', 'start', 'end', 'loc', 'range', 'raw']);
const isFn = (n) => Boolean(n) && FUNCTION_TYPES.has(n.type);

function children(node){
    const out = [];
    for(const key of Object.keys(node)){
        if(SKIP_KEYS.has(key)) continue;
        const v = node[key];
        if(Array.isArray(v)) v.forEach((c) => { if(c && typeof c.type === 'string') out.push(c); });
        else if(v && typeof v.type === 'string') out.push(v);
    }
    return out;
}

// Names a binding pattern declares.
function patternNames(node, out){
    if(!node) return out;
    switch(node.type){
        case 'Identifier':        out.push(node.name); break;
        case 'AssignmentPattern': patternNames(node.left, out); break;
        case 'RestElement':       patternNames(node.argument, out); break;
        case 'ArrayPattern':      node.elements.forEach((e) => patternNames(e, out)); break;
        case 'ObjectPattern':     node.properties.forEach((p) => patternNames(p.type === 'RestElement' ? p : p.value, out)); break;
    }
    return out;
}

// Every name a function body declares, hoisted to the function: var, let,
// const, class, inner function names and catch params. Treating block-scoped
// names as function-scoped can only hide a global read that shares a name
// with a local elsewhere in the same function.
function hoisted(body, out){
    const visit = (node) => {
        if(node.type === 'VariableDeclaration') node.declarations.forEach((d) => patternNames(d.id, out));
        else if(node.type === 'CatchClause') patternNames(node.param, out);
        else if((node.type === 'FunctionDeclaration' || node.type === 'ClassDeclaration') && node.id) out.push(node.id.name);
        if(!isFn(node)) children(node).forEach(visit);
    };
    if(body.type === 'BlockStatement') children(body).forEach(visit);
    else visit(body);
    return out;
}

/**
 * The reading walk. `shallow` stops at every function that is not invoked
 * where it stands, which leaves exactly what runs while the script executes.
 */
class Reader {
    constructor(shallow){
        this.shallow = shallow;
        this.invoked = new WeakSet();
    }

    collect(node, scope, out){
        if(!node || typeof node.type !== 'string') return;
        const handler = Reader.HANDLERS[node.type];
        if(handler && handler.call(this, node, scope, out) !== false) return;
        if(isFn(node)) return this.fn(node, scope, out);
        children(node).forEach((c) => this.collect(c, scope, out));
    }

    fn(node, scope, out){
        if(this.shallow && !this.invoked.has(node)) return;
        const inner = new Set(scope);
        inner.add('arguments');
        if(node.id) inner.add(node.id.name);
        node.params.forEach((p) => patternNames(p, []).forEach((n) => inner.add(n)));
        hoisted(node.body, []).forEach((n) => inner.add(n));
        node.params.forEach((p) => this.pattern(p, inner, out));
        this.collect(node.body, inner, out);
    }

    // A binding pattern reads only its default values and computed keys.
    pattern(node, scope, out){
        if(!node) return;
        if(node.type === 'AssignmentPattern'){ this.pattern(node.left, scope, out); this.collect(node.right, scope, out); }
        else if(node.type === 'RestElement') this.pattern(node.argument, scope, out);
        else if(node.type === 'ArrayPattern') node.elements.forEach((e) => this.pattern(e, scope, out));
        else if(node.type === 'ObjectPattern') node.properties.forEach((p) => {
            if(p.type === 'RestElement') return this.pattern(p, scope, out);
            if(p.computed) this.collect(p.key, scope, out);
            this.pattern(p.value, scope, out);
        });
    }

    call(node, scope, out){
        const callee = node.callee;
        // `(function(){...})()` and `(function(){...}).call(this)` run in place.
        if(isFn(callee)) this.invoked.add(callee);
        if(callee.type === 'MemberExpression' && isFn(callee.object)) this.invoked.add(callee.object);
        if(callee.type === 'MemberExpression' && !callee.computed){
            const name = callee.property.name;
            // A plugin counts only when called: `$.fn.dataTable && ...` is a guard.
            if(PLUGIN_MEMBERS.has(name)) out.add('.' + name);
            const arg = node.arguments[COMPONENT_CALLS[name]];
            if(Object.prototype.hasOwnProperty.call(COMPONENT_CALLS, name) && callee.object.type === 'Identifier'
                && callee.object.name === 'XCComponents' && arg && typeof arg.value === 'string')
                out.add('component:' + arg.value);
        }
        return false;
    }
}

const literalAttrs = (text, out) => PLUGIN_ATTRS.forEach((a) => { if(text.includes(a)) out.add('@' + a); });

Reader.HANDLERS = {
    Identifier(node, scope, out){ if(!scope.has(node.name)) out.add('id:' + node.name); },
    Literal(node, scope, out){ if(typeof node.value === 'string') literalAttrs(node.value, out); },
    TemplateElement(node, scope, out){ literalAttrs(node.value.raw, out); },
    MemberExpression(node, scope, out){
        this.collect(node.object, scope, out);
        if(node.computed) this.collect(node.property, scope, out);
    },
    CallExpression(node, scope, out){ return this.call(node, scope, out); },
    NewExpression(node, scope, out){ return this.call(node, scope, out); },
    // Assigning an undeclared name makes it a global of this script's own,
    // so a later read of it in the same body is not a dependency.
    AssignmentExpression(node, scope, out){
        if(node.left.type !== 'Identifier' || scope.has(node.left.name)) return false;
        out.add('w:' + node.left.name);
        this.collect(node.right, scope, out);
    },
    Property(node, scope, out){ if(node.computed) this.collect(node.key, scope, out); this.collect(node.value, scope, out); },
    LabeledStatement(node, scope, out){ this.collect(node.body, scope, out); },
    BreakStatement(){}, ContinueStatement(){}, MetaProperty(){},
    VariableDeclarator(node, scope, out){ this.pattern(node.id, scope, out); this.collect(node.init, scope, out); },
    CatchClause(node, scope, out){ this.pattern(node.param, scope, out); this.collect(node.body, scope, out); },
    ClassDeclaration(node, scope, out){ this.collect(node.superClass, scope, out); this.collect(node.body, scope, out); }
};
Reader.HANDLERS.PropertyDefinition = Reader.HANDLERS.Property;
Reader.HANDLERS.MethodDefinition   = Reader.HANDLERS.Property;
Reader.HANDLERS.ClassExpression    = Reader.HANDLERS.ClassDeclaration;
// typeof X is a guard; anything else under a unary operator is an ordinary read.
Reader.HANDLERS.UnaryExpression = function(node){
    return (node.operator === 'typeof' && node.argument.type === 'Identifier') ? undefined : false;
};

// `NAME = ...` or `window.NAME = ...` at statement level: an implicit global.
function assignedGlobal(stmt){
    if(stmt.type !== 'ExpressionStatement' || stmt.expression.type !== 'AssignmentExpression') return null;
    const left = stmt.expression.left;
    if(left.type === 'Identifier') return left.name;
    if(left.type === 'MemberExpression' && !left.computed && left.object.type === 'Identifier'
        && left.object.name === 'window') return left.property.name;
    return null;
}

// UMD and guarded exports install a global from inside a wrapper:
// `root.XCC = factory()`, `if(...) window.XCTimelineItem = item`, or through
// an alias such as `var xcChartsRoot = (typeof self !== 'undefined') ? self : this`.
const GLOBAL_OBJECTS = ['window', 'self', 'root', 'globalThis'];
const isGlobalObject = (n) => Boolean(n) && (n.type === 'ThisExpression'
    || (n.type === 'Identifier' && GLOBAL_OBJECTS.includes(n.name))
    || (n.type === 'ConditionalExpression' && isGlobalObject(n.consequent) && isGlobalObject(n.alternate)));

function walk(node, visit){
    if(!node || typeof node.type !== 'string') return;
    visit(node);
    children(node).forEach((c) => walk(c, visit));
}

function wrappedGlobals(ast){
    const objects = new Set(GLOBAL_OBJECTS);
    const out = [];
    walk(ast, (n) => {
        if(n.type === 'VariableDeclarator' && n.id.type === 'Identifier' && isGlobalObject(n.init)) objects.add(n.id.name);
    });
    walk(ast, (n) => {
        if(n.type === 'AssignmentExpression' && n.left.type === 'MemberExpression' && !n.left.computed
            && n.left.object.type === 'Identifier' && objects.has(n.left.object.name))
            out.push(n.left.property.name);
    });
    return out;
}

// Every global the file declares or assigns at statement level, plus a `var`
// inside a top-level block, which is a global all the same.
function topLevelNames(ast){
    const out = new Set();
    const vars = (node) => {
        if(isFn(node)) return;
        if(node.type === 'VariableDeclaration' && node.kind === 'var')
            node.declarations.forEach((d) => patternNames(d.id, []).forEach((n) => out.add(n)));
        children(node).forEach(vars);
    };
    vars(ast);
    for(const stmt of ast.body){
        if((stmt.type === 'FunctionDeclaration' || stmt.type === 'ClassDeclaration') && stmt.id) out.add(stmt.id.name);
        else if(stmt.type === 'VariableDeclaration') stmt.declarations.forEach((d) => patternNames(d.id, []).forEach((n) => out.add(n)));
        else { const name = assignedGlobal(stmt); if(name) out.add(name); }
    }
    return out;
}

// Drop reads of names the same body assigns, then the write markers; return
// the names written.
function settle(tokens){
    const written = [];
    for(const t of [...tokens]){
        if(!t.startsWith('w:')) continue;
        tokens.delete(t);
        tokens.delete('id:' + t.slice(2));
        written.push(t.slice(2));
    }
    return written;
}

// One top-level `var` declarator. `var RENDERERS = { line: renderLine }` reads
// a hoisted function of this same file: that is a need of whoever reads
// RENDERERS, not of every page that loads the file. Other files' names are
// read as the file runs, so they stay load-time.
function declarator(d, own, reader, add, load){
    const names = patternNames(d.id, []);
    names.forEach(add);
    if(d.id.type === 'Identifier' && isFn(d.init)) return reader.collect(d.init, new Set(), add(d.id.name));
    const reads = new Set();
    reader.collect(d.init, new Set(), reads);
    for(const t of reads){
        if(t.startsWith('id:') && own.has(t.slice(3))) names.forEach((n) => add(n).add(t));
        else load.add(t);
    }
}

function statement(stmt, own, reader, add, load){
    if(stmt.type === 'FunctionDeclaration' || stmt.type === 'ClassDeclaration')
        return reader.collect(stmt, new Set(), add(stmt.id.name));
    if(stmt.type === 'VariableDeclaration')
        return stmt.declarations.forEach((d) => declarator(d, own, reader, add, load));
    const name = assignedGlobal(stmt);
    if(name && isFn(stmt.expression.right)) return reader.collect(stmt.expression.right, new Set(), add(name));
    if(name) add(name);
    reader.collect(stmt, new Set(), load);
}

/**
 * Scan one script.
 *
 * @param {string} src
 * @returns {{ provides: Map<string, Set<string>>, load: Set<string>, parse: Set<string> }}
 *   provides: each global the file declares, with the tokens its body reads;
 *   load: tokens read by the file's top-level statements, callbacks included,
 *         so a file on the page needs them whatever else is called;
 *   parse: tokens read while the file itself executes, callbacks excluded,
 *         which must already be defined when it runs.
 */
function scanScript(src){
    const ast = acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'script', allowHashBang: true });
    const provides = new Map();
    const load = new Set();
    const add = (name) => { if(!provides.has(name)) provides.set(name, new Set()); return provides.get(name); };
    const own = topLevelNames(ast);
    const reader = new Reader(false);
    ast.body.forEach((stmt) => statement(stmt, own, reader, add, load));
    own.forEach(add);
    wrappedGlobals(ast).forEach(add);
    // A function that assigns an undeclared name (`cachedJson = json`) installs
    // that global for every other function to read.
    const written = settle(load);
    provides.forEach((body) => written.push(...settle(body)));
    written.forEach(add);
    const parse = new Set();
    const shallow = new Reader(true);
    ast.body.forEach((stmt) => shallow.collect(stmt, new Set(), parse));
    settle(parse);
    own.forEach((n) => parse.delete('id:' + n));
    return { provides, load, parse };
}

module.exports = { scanScript, PLUGIN_MEMBERS, PLUGIN_ATTRS };
