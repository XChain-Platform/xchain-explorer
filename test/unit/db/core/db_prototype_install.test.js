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
 * How mixinReaders INSTALLS a method, as opposed to which methods it installs.
 *
 * db_reader_composition.test.js already pins the surface: every method declared
 * in a module under src/db/ reaches Database.prototype, and no name is declared
 * twice. It says nothing about the property DESCRIPTOR each one arrives with,
 * and that is the half the carve could break silently.
 *
 * A class-body method is non-enumerable. mixinReaders copies
 * getOwnPropertyDescriptor rather than the value for exactly that reason; swap
 * it for `target[name] = source[name]` and every method installs as an
 * ENUMERABLE own property of the prototype. Nothing throws. Every call site
 * still works. What changes is that `for (const key in db)` starts yielding 285
 * method names alongside the instance fields, which is how the explorer walks
 * an object in several render and serialisation paths, and how a plain
 * `{...db}` or a JSON round-trip of a Database-shaped object behaves. A defect
 * of that shape shows up as a page rendering hundreds of stray keys, or as a
 * response body suddenly carrying function names, far from the commit that
 * caused it.
 *
 * Object.assign would have been worse and is the mistake this guards against
 * from the other side: it copies ENUMERABLE own properties only, so assigning
 * a class prototype copies nothing at all and every reader silently vanishes.
 *
 * So this asserts the descriptor, not the presence: non-enumerable, writable
 * and configurable (what a class body produces), a real function, and arity
 * preserved, over every extracted module rather than a sample.
 */

'use strict';

const fs     = require('fs');
const path   = require('path');
const assert = require('assert');

const Database = require('../../../../src/db/index.js');

const SRC    = path.resolve(__dirname, '..', '..', '../../src');
const DB_DIR = path.join(SRC, 'db');
const METHOD = /^ {4}(?:async\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*\(/;

/** Every .js file under a directory, recursively, relative to src/. */
function jsFilesUnder(absDir){
    if (!fs.existsSync(absDir)) return [];
    const out = [];
    for (const entry of fs.readdirSync(absDir, { withFileTypes: true })) {
        const abs = path.join(absDir, entry.name);
        if (entry.isDirectory()) out.push(...jsFilesUnder(abs));
        else if (entry.name.endsWith('.js')) out.push(path.relative(SRC, abs));
    }
    return out.sort();
}

/**
 * Method names a file's class bodies declare. Read from source text, not from
 * the required module, because the question is what the FILES put on the
 * prototype: a module that exports something other than a class prototype would
 * still answer this by require and hide the defect.
 */
function classBodyMethods(relPath){
    const lines = fs.readFileSync(path.join(SRC, relPath), 'utf8').split('\n');
    let inClass = false;
    const names = [];
    for (const line of lines) {
        if (/^class\s+[A-Za-z_][A-Za-z0-9_]*/.test(line)) { inClass = true; continue; }
        if (inClass && /^\}/.test(line)) { inClass = false; continue; }
        if (!inClass) continue;
        const m = METHOD.exec(line);
        if (m && m[1] !== 'constructor') names.push(m[1]);
    }
    return names;
}

// Every name declared by a module under src/db/, with the file it came from, so
// a failure names the module rather than only the method.
const DECLARED = [];
for (const rel of jsFilesUnder(DB_DIR))
    for (const name of classBodyMethods(rel)) DECLARED.push({ rel, name });

describe('mixinReaders installs every extracted method non-enumerably', function(){
    it('found methods to check (the walk itself is not silently empty)', function(){
        assert.ok(DECLARED.length >= 100,
            'only ' + DECLARED.length + ' methods found under src/db/; the source walk broke, ' +
            'and every assertion below would pass vacuously');
    });

    it('installs no method as an enumerable property of the prototype', function(){
        const enumerable = DECLARED
            .filter(({ name }) => {
                const d = Object.getOwnPropertyDescriptor(Database.prototype, name);
                return d && d.enumerable;
            })
            .map(({ rel, name }) => rel + ': ' + name);
        assert.deepStrictEqual(enumerable, [],
            'method(s) installed as ENUMERABLE own properties of Database.prototype. ' +
            'mixinReaders must copy getOwnPropertyDescriptor, not the value: an assignment ' +
            'makes every for-in over a Database instance yield these names.');
    });

    it('leaves Object.keys and for-in over the prototype empty', function(){
        assert.deepStrictEqual(Object.keys(Database.prototype), []);
        const seen = [];
        for (const key in Database.prototype) seen.push(key);
        assert.deepStrictEqual(seen, [],
            'for-in over Database.prototype yielded ' + seen.length + ' name(s); ' +
            'a mixed-in method became enumerable');
    });

    it('yields no method name from a for-in over a constructed instance', function(){
        // The instance is what render and serialisation paths actually walk, and
        // for-in follows the prototype chain, so this is the failure as a caller
        // would meet it rather than as the prototype reports it.
        const db = new Database({
            configInfo: { onConfigChanged(){} },
            util:       {}
        });
        const names = new Set(DECLARED.map((d) => d.name));
        const leaked = [];
        for (const key in db) if (names.has(key)) leaked.push(key);
        assert.deepStrictEqual(leaked, [],
            'for-in over a Database INSTANCE yielded method name(s): ' + leaked.join(', '));
    });

    it('installs each method writable and configurable, as a class body does', function(){
        const wrong = DECLARED
            .map(({ rel, name }) => ({ rel, name, d: Object.getOwnPropertyDescriptor(Database.prototype, name) }))
            .filter(({ d }) => !d || d.writable !== true || d.configurable !== true)
            .map(({ rel, name }) => rel + ': ' + name);
        assert.deepStrictEqual(wrong, [],
            'method(s) installed with a descriptor a class body would not produce; ' +
            'sinon.stub and every test double depend on writable+configurable');
    });
});

describe('mixinReaders installs every extracted method non-enumerably', function(){
    it('installs a real function with its arity intact', function(){
        const broken = DECLARED
            .filter(({ name }) => typeof Database.prototype[name] !== 'function')
            .map(({ rel, name }) => rel + ': ' + name);
        assert.deepStrictEqual(broken, [], 'declared in a module but not a function on the prototype');

        // Arity is carried by the descriptor's value, so a copy that rebuilt the
        // function (a wrapper, a bind) would lose it while every other assertion
        // here still passed.
        const zeroArity = DECLARED.filter(({ name }) => Database.prototype[name].length === 0).length;
        assert.ok(zeroArity < DECLARED.length,
            'every extracted method reports arity 0; the install is wrapping functions rather than ' +
            'copying them, and the original signatures are gone');
    });

});
