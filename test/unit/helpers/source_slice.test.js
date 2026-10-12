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
 **********************************************************************/

'use strict';

const fs   = require('fs');
const path = require('path');
const { expect } = require('chai');

const { extractBlock, extractFn } = require('../../helpers/source_slice');

const TEST_ROOT = path.resolve(__dirname, '..', '..');
const HELPER    = path.join(TEST_ROOT, 'helpers', 'source_slice.js');
// Built from parts so this file does not match its own search.
const LOCAL_COPY = 'function ' + 'extractFn(';

function jsFilesUnder(dir){
    const files = [];
    for(const entry of fs.readdirSync(dir, { withFileTypes: true })){
        const full = path.join(dir, entry.name);
        if(entry.isDirectory()) files.push(...jsFilesUnder(full));
        else if(entry.isFile() && entry.name.endsWith('.js')) files.push(full);
    }
    return files;
}

describe('shared source slicer', function(){
    const SRC = [
        'function outer(a) { if (a) { return { k: 1 }; } return null; }',
        'function second() { return 2; }',
        'function outer(b) { return "later"; }',
        'var XC = { list_types: { 1: "allow", 2: "block" }, other: {} };'
    ].join('\n');

    it('slices a function through the brace that closes it, nested braces included', function(){
        expect(extractFn(SRC, 'outer')).to.equal('function outer(a) { if (a) { return { k: 1 }; } return null; }');
    });

    it('takes the first definition when a name appears twice', function(){
        expect(extractFn(SRC, 'outer')).to.contain('(a)');
        expect(extractFn(SRC, 'second')).to.equal('function second() { return 2; }');
    });

    it('slices a block from a needle that is not a function signature', function(){
        expect(extractBlock(SRC, 'list_types: {')).to.equal('list_types: { 1: "allow", 2: "block" }');
    });

    it('throws when the function is missing, naming the source', function(){
        expect(() => extractFn(SRC, 'absent', 'xchain.js')).to.throw('function not found in xchain.js: absent');
    });

    it('throws when the braces never balance instead of returning the rest of the text', function(){
        expect(() => extractFn('function open() { if (x) { return 1; }', 'open')).to.throw(/unterminated block/);
    });

    it('throws when no opening brace follows the needle', function(){
        expect(() => extractBlock('var a = 1;', 'var a')).to.throw(/no opening brace/);
    });

    it('is the only slicer of its name under test/, so suites share one walker', function(){
        const copies = jsFilesUnder(TEST_ROOT)
            .filter((file) => file !== HELPER)
            .filter((file) => fs.readFileSync(file, 'utf8').includes(LOCAL_COPY))
            .map((file) => path.relative(TEST_ROOT, file));
        expect(copies, 'suites that define their own slicer instead of requiring test/helpers/source_slice.js').to.deep.equal([]);
    });
});
