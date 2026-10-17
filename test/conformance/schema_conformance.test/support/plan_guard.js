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
 * Query-plan guard: EXPLAIN every routed list reader's row and count query
 * against the real DDL with seeded tables, and fail on a plan that reads a
 * production-large table whole unless plan_allowlist.txt names it.
 *
 * Unit tests assert SQL strings, so a full scan, a correlated subquery per
 * counted row, or a filter no index serves ships green and only shows up as a
 * slow production endpoint. This tier sees the plan instead.
 *
 * Runs after every other conformance test, because seeding rewrites the
 * tables those tests expect near-empty.
 *
 ********************************************************************/

'use strict';

const { expect, INDEXER_DB, HUB_DB } = require('../../schema_conformance.test.js');
const seed      = require('./plan_seed.js');
const capture   = require('./plan_capture.js');
const verdict   = require('./plan_verdict.js');
const allowlist = require('./plan_allowlist.js');

// Coverage floors: a rig that silently stopped probing or explaining would
// otherwise pass with an empty offender list.
const MIN_PROBES     = 300;
const MIN_STATEMENTS = 550;

// The server's message without the driver's connection prefix or the echoed SQL,
// so the same failure reads the same on every run.
function errorText(message) {
    return String(message).split('\n')[0].replace(/^SQL query failed: /, '').replace(/^\(conn:[^)]*\)\s*/, '');
}

// A probe that errors or whose plan EXPLAIN settles at plan time is a probe the
// guard cannot judge. Both go through the same allowlist ratchet as offenders,
// so the set of unjudged probes can shrink but never quietly grow.
function recordBlindSpot(result, probe, kind, finding, reason) {
    const key = [probe.method, probe.filter, kind, '-', finding].join(' ');
    if (!result.observed.has(key)) result.observed.set(key, reason);
}

async function explainProbe(db, probe, largeTables, result) {
    const { statements, error, explain } = await capture.captureProbe(db, probe);
    if (error) {
        result.errors.push(probe.method + ' ' + probe.filter + ': ' + error);
        recordBlindSpot(result, probe, '-', 'error', 'the reader fails: ' + errorText(error));
    }
    for (const s of statements) {
        let rows;
        try { rows = await explain(s); }
        catch (e) {
            result.errors.push(probe.method + ' ' + probe.filter + ' EXPLAIN ' + s.kind + ': ' + errorText(e.message));
            recordBlindSpot(result, probe, '-', 'error', 'the reader fails: ' + errorText(e.message));
            continue;
        }
        result.statements++;
        const judged = verdict.judgePlan({ sql: s.sql, kind: s.kind, rows, largeTables, filtered: probe.filter !== 'all' });
        if (judged.unjudgeable) {
            result.unjudgeable.push(probe.method + ' ' + probe.filter + ' ' + s.kind + ': ' + judged.unjudgeable);
            recordBlindSpot(result, probe, s.kind, 'unjudged', 'the probe value matches no seeded row, so EXPLAIN ' +
                'settles the WHERE at plan time and shows no plan');
            continue;
        }
        for (const f of judged.findings)
            result.observed.set(verdict.findingKey(probe, s.kind, f), verdict.describeFinding(probe, s.kind, f));
    }
}

async function runPlanGuard(runtime) {
    const { adminPool, explorer, db } = runtime.state;
    const result = { probes: 0, statements: 0, observed: new Map(), unjudgeable: [], errors: [], seedFailures: [] };
    for (const name of [INDEXER_DB, HUB_DB])
        result.seedFailures.push(...await seed.seedSchema(adminPool, name));
    const largeTables = await seed.largeTables(adminPool, [INDEXER_DB, HUB_DB]);
    capture.clearResultCaches(db);
    for (const probe of capture.listProbes(explorer.urls.api, db)) {
        result.probes++;
        await explainProbe(db, probe, largeTables, result);
    }
    return result;
}

function report(result) {
    console.log('plan guard: ' + result.probes + ' probes, ' + result.statements + ' statements explained, ' +
        result.observed.size + ' offending plans');
    for (const [label, list] of [['seed failures', result.seedFailures],
        ['reader errors (plans still judged)', result.errors], ['plans settled at plan time, not judged', result.unjudgeable]])
        if (list.length) console.log('plan guard: ' + label + ':\n  ' + list.join('\n  '));
}

// The allowlist is taken on the CI venue's MariaDB 10.11, and the reconcile
// verdicts enforce by default. PLAN_GUARD_ENFORCE=0 turns them into a printed
// diff under a PLAN_GUARD_DIFF marker, for retaking the list on a venue whose
// planner differs.
const ENFORCE = process.env.PLAN_GUARD_ENFORCE !== '0';

function reconcileVerdict(lines, message) {
    if (ENFORCE) {
        expect(lines, message + '\n' + lines.join('\n')).to.deep.equal([]);
        return;
    }
    if (lines.length) console.log('PLAN_GUARD_DIFF ' + message + '\n  ' + lines.join('\n  '));
}

function registerPlanGuard(runtime) {
    describe('query-plan guard (EXPLAIN against seeded real DDL)', function () {
        this.timeout(900000);
        const state = { result: null, entries: null, errors: null };

        before(async function () {
            state.result = await runPlanGuard(runtime);
            ({ entries: state.entries, errors: state.errors } = allowlist.readAllowlist());
            report(state.result);
            if (process.env.PLAN_GUARD_WRITE === '1') {
                allowlist.writeAllowlist(state.entries, state.result.observed);
                ({ entries: state.entries, errors: state.errors } = allowlist.readAllowlist());
            }
        });

        it('reads a well-formed allowlist', function () {
            expect(state.errors, state.errors.join('\n')).to.deep.equal([]);
        });

        it('finds no plan offender missing from the allowlist', function () {
            const { offenders } = allowlist.reconcile(state.entries, state.result.observed);
            reconcileVerdict(offenders, 'plans reading a production-large table whole; index the query, or add the line ' +
                'to ' + allowlist.ALLOWLIST_PATH + ' with the reason it cannot be:');
        });

        it('carries no stale allowlist entry', function () {
            const { stale } = allowlist.reconcile(state.entries, state.result.observed);
            reconcileVerdict(stale, 'allowlisted plans that no longer offend; remove these lines from ' +
                allowlist.ALLOWLIST_PATH + ':');
        });

        it('probed and explained enough plans to mean something', function () {
            if (!ENFORCE) {
                console.log('PLAN_GUARD_DIFF probes ' + state.result.probes + ', statements ' + state.result.statements);
                return;
            }
            expect(state.result.probes).to.be.at.least(MIN_PROBES, 'probe list collapsed');
            expect(state.result.statements).to.be.at.least(MIN_STATEMENTS, 'too few statements explained');
        });
    });
}

module.exports = { registerPlanGuard, runPlanGuard };
