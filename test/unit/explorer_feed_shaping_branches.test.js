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
 **********************************************************************
 *
 * A method registered in the /explorer route table does not automatically get
 * a getPagingDataResults shaping branch, and a feed missing one fails
 * SILENTLY: it answers 200 with raw DB objects where the datatables client
 * expects positional arrays, so the page renders garbage or empty and nothing
 * errors. That gap shipped at least three times (the coinpay feeds, the
 * cross-chain match feed, and the order/swap match feeds), each found by a
 * human reading code rather than by a gate. The sibling
 * content-client-datatable-endpoints test pins page-to-endpoint; this pins
 * endpoint-to-shaping-branch, both directions: every registered /explorer
 * method must shape its rows, and every shaping branch must belong to a
 * registered method (an orphan branch is dead code hiding a rename or a
 * deregistration).
 *********************************************************************/

'use strict';

const fs   = require('fs');
const path = require('path');
const { expect } = require('chai');

const EXPLORER = fs.readFileSync(path.resolve(__dirname, '../../src/XChainExplorer.js'), 'utf8');

// Every method the live urls.explorer table registers, read from the source
// rather than restated here, so the assertion cannot drift from it.
function registeredExplorerMethods() {
    const out = new Set();
    for (const m of EXPLORER.matchAll(/'\/\{COIN\}\/explorer\/[^']+'\s*:\s*\['(\w+)'/g))
        out.add(m[1]);
    return out;
}

// The explorer-type shaping block of getPagingDataResults. Sliced by the
// markers the function actually carries so a refactor that moves or renames
// them fails loudly here instead of silently emptying the branch set.
function shapingBranchMethods() {
    const fnStart = EXPLORER.indexOf('getPagingDataResults(');
    if (fnStart < 0) throw new Error('getPagingDataResults not found in XChainExplorer.js');
    const body = EXPLORER.slice(fnStart);
    const expStart = body.indexOf("if(type=='explorer'){");
    if (expStart < 0) throw new Error("the type=='explorer' shaping block was not found");
    // The shaping block ends where the per-row loop pushes the shaped row.
    const expEnd = body.indexOf('show.push(info);', expStart);
    if (expEnd < 0) throw new Error('the end of the shaping block (show.push) was not found');
    const block = body.slice(expStart, expEnd);
    const out = new Set();
    for (const m of block.matchAll(/if\(method=='(\w+)'\)/g))
        out.add(m[1]);
    for (const m of block.matchAll(/if\(\[([^\]]+)\]\.includes\(method\)\)/g))
        m[1].split(',').forEach(s => out.add(s.trim().replace(/^'|'$/g, '')));
    return out;
}

describe('explorer feed shaping branches', function () {

    it('shapes every method registered in urls.explorer', function () {
        const registered = registeredExplorerMethods();
        const shaped     = shapingBranchMethods();
        const unshaped   = [...registered].filter(m => !shaped.has(m)).sort();
        expect(unshaped, 'registered /explorer methods whose rows reach the client unshaped:\n'
            + unshaped.join('\n')).to.deep.equal([]);
    });

    it('registers every method a shaping branch names', function () {
        const registered = registeredExplorerMethods();
        const shaped     = shapingBranchMethods();
        const orphaned   = [...shaped].filter(m => !registered.has(m)).sort();
        expect(orphaned, 'shaping branches with no urls.explorer registration:\n'
            + orphaned.join('\n')).to.deep.equal([]);
    });

    // A parse that quietly matched nothing would make both assertions above
    // pass vacuously; the table and the branch set are both large and only grow.
    it('finds a plausibly-sized method table and branch set', function () {
        expect(registeredExplorerMethods().size).to.be.greaterThan(50);
        expect(shapingBranchMethods().size).to.be.greaterThan(50);
    });

});
