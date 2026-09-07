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
 * db.js is being decomposed into src/db/ one reader family at a time. The whole
 * claim of that decomposition is that NOTHING moves for a caller: every method
 * is still reached as db.getWhatever(...).
 *
 * The failure mode a move like this has is silence. A module that is written
 * but never wired into the composition, or a method whose name collides with
 * one already on the prototype, does not throw at import time in the general
 * case; it throws at 2am on the one page that calls it. So this pins the
 * composition itself:
 *
 *   1. Every method declared in every module under src/db/ is present on
 *      Database.prototype.
 *   2. Every module file under src/db/ is actually composed in. Adding a file
 *      and forgetting the require line in db.js goes red here rather than on
 *      the page.
 *   3. No name is declared twice across db.js and the modules, so no family
 *      can shadow another's query by require order.
 *
 * Read from source text rather than by requiring each module, because the
 * point is what the FILES declare, not what a successful composition happens
 * to expose.
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { expect } = require('chai');

const Database = require('../../src/db.js');

const SRC     = path.resolve(__dirname, '../../src');
const DB_DIR  = path.join(SRC, 'db');
const METHOD  = /^ {4}(?:async\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*\(/;

/** Every .js file under a directory, recursively, as paths relative to src/. */
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
 * Method names declared in a file's class bodies. A class body opens on
 * `^class <Name>` and closes on the first `^}` after it, which is the only
 * place a top-level brace lands in these files; reading to EOF instead would
 * sweep in the composition call that follows the class in db.js.
 */
function classBodyMethods(relPath, classFilter){
    const lines = fs.readFileSync(path.join(SRC, relPath), 'utf8').split('\n');
    let inClass = false;
    const names = [];
    for (const line of lines) {
        const opener = /^class\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(line);
        if (opener) inClass = classFilter ? opener[1] === classFilter : true;
        else if (inClass && /^\}/.test(line)) inClass = false;
        if (!inClass) continue;
        const m = METHOD.exec(line);
        if (m && m[1] !== 'constructor') names.push(m[1]);
    }
    return names;
}

const MODULES = jsFilesUnder(DB_DIR);

describe('db.js composes its extracted reader families', function(){

    it('has extracted at least one family (the decomposition has not been reverted)', function(){
        expect(MODULES, 'nothing under src/db/; proposal B stage 4 was reverted or moved')
            .to.not.be.empty;
    });

    it('reaches every extracted method on Database.prototype', function(){
        const missing = [];
        for (const rel of MODULES)
            for (const name of classBodyMethods(rel, null))
                if (!Object.prototype.hasOwnProperty.call(Database.prototype, name))
                    missing.push(`${rel}: ${name}`);
        expect(missing, 'declared in a module but never reached the prototype; is the module wired into db.js?')
            .to.deep.equal([]);
    });

    it('wires every module file into the composition', function(){
        const src = fs.readFileSync(path.join(SRC, 'db.js'), 'utf8');
        const unwired = MODULES.filter((rel) => !src.includes(`./${rel.split(path.sep).join('/')}`));
        expect(unwired, 'module file(s) under src/db/ that db.js never requires')
            .to.deep.equal([]);
    });

    it('declares no method name twice across db.js and the modules', function(){
        const names = classBodyMethods('db.js', 'Database')
            .concat(...MODULES.map((rel) => classBodyMethods(rel, null)));
        const seen  = new Set();
        const dupes = [...new Set(names.filter((n) => (seen.has(n) ? true : (seen.add(n), false))))];
        expect(dupes, 'a duplicate name would be resolved by require order, and the loser would vanish silently')
            .to.deep.equal([]);
    });

    it('spot-checks one method from each family, since a family could be empty', function(){
        for (const name of ['getAddresses', 'getTokens', 'getMarkets', 'getOrderbook', 'getStakes', 'getGovernanceVotes'])
            expect(Database.prototype[name], `${name} is not callable on Database.prototype`)
                .to.be.a('function');
    });

});
