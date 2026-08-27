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
 * An ACTION's source is `actions.source_id`, never `transactions.source_id`.
 * The two agree for every user action and DISAGREE for a VM emission: the
 * indexer stores the emitting contract's derived address on the action row
 * (xchain-indexer db.js createActionIndex, execute.js processEmission) while
 * the transaction still belongs to the human who sent the EXECUTE.
 *
 * Every action-detail and list query used to join the TRANSACTION, so every
 * emitted action of every type rendered the caller's address: a real address
 * that is the wrong one, which no reader can catch by eye. Found by driving
 * /RDOGE/action/1211 on the regtest venue, where the emit probe's BROADCAST
 * was attributed to myAzbja... instead of to contract 1209.
 *
 * This is a STRUCTURAL pin rather than a behavioural one because the defect is
 * a class spread over ~130 join sites in two files: a per-query behavioural
 * test would pin the handful someone remembered to cover and let the next new
 * query reintroduce it silently. The rule is mechanical, so the test is too.
 *********************************************************************/

'use strict';

const fs   = require('fs');
const path = require('path');
const { expect } = require('chai');

const SRC   = path.resolve(__dirname, '../../src');
const FILES = ['db.js', ...fs.readdirSync(path.join(SRC, 'action-detail'))
    .filter(f => f.endsWith('.js'))
    .map(f => path.join('action-detail', f))];

// Walk each file's SQL template literals. Backtick-delimited chunks at odd indexes
// are the template literals; the query text is what matters, not the surrounding JS.
function sqlLiterals(rel){
    const src = fs.readFileSync(path.join(SRC, rel), 'utf8');
    const out = [];
    const chunks = src.split('`');
    let offset = 0;
    for (let i = 0; i < chunks.length; i++) {
        const line = src.slice(0, offset).split('\n').length;
        offset += chunks[i].length + 1;
        if (i % 2 === 1) out.push({ line, sql: chunks[i] });
    }
    return out;
}

describe('an action\'s source is the ACTION\'s source, not the transaction\'s', function(){

    it('resolves no address directly from transactions.source_id', function(){
        const offenders = [];
        for (const rel of FILES)
            for (const { line, sql } of sqlLiterals(rel))
                if (/\w+\.id\s*=\s*t1\.source_id/.test(sql))
                    offenders.push(`${rel}:${line}`);
        expect(offenders, 'these queries attribute an action to its transaction sender')
            .to.deep.equal([]);
    });

    it('filters no address directly on transactions.source_id', function(){
        const offenders = [];
        for (const rel of FILES) {
            const src = fs.readFileSync(path.join(SRC, rel), 'utf8');
            const lines = src.split('\n');
            lines.forEach((l, i) => {
                if (/t1\.source_id\s*=\s*\?/.test(l)) offenders.push(`${rel}:${i + 1}`);
            });
        }
        // A paging boundary that filters differently from the row query it pages makes an
        // emitted action list under one address and page under another.
        expect(offenders, 'these filters page by the transaction sender')
            .to.deep.equal([]);
    });

    it('coalesces to the transaction only as a fallback, and only from an actions alias', function(){
        let checked = 0;
        for (const rel of FILES) {
            for (const { line, sql } of sqlLiterals(rel)) {
                const uses = [...sql.matchAll(/COALESCE\((\w+)\.source_id,\s*t1\.source_id\)/g)];
                if (!uses.length) continue;
                // Skip bare WHERE fragments (getQueryOffsets builds its predicates apart from
                // the query they are concatenated into, so the join they rely on is not in
                // this literal). Their correctness is pinned by the filter test above.
                if (!/\bFROM\b/.test(sql)) continue;
                // The alias named first must be the `actions` row joined in this same query,
                // or the COALESCE reads some other table's source column entirely.
                const actionsAlias = (sql.match(/\bactions\s+(\w+)\b/) || [])[1];
                expect(actionsAlias, `${rel}:${line} coalesces without joining actions`).to.be.a('string');
                for (const u of uses) {
                    expect(u[1], `${rel}:${line} coalesces from ${u[1]}, not the actions alias`)
                        .to.equal(actionsAlias);
                    checked++;
                }
            }
        }
        // Guards against the whole class being "fixed" by deleting the joins: if the count
        // collapses, the pages stopped resolving a source at all.
        expect(checked, 'source-resolving joins found').to.be.at.least(100);
    });
});
