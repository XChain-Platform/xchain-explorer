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
 */

'use strict';

const { expect, makeConfig, PROBE_ARGS, isSchemaError } = require('../../schema_conformance.test.js');

function registerRoutedReadPaths(runtime) {
    it('runs every routed db.getData read path without a schema error', async function () {
        const { explorer, db } = runtime.state;
        await runtime.seedRichListSubject();
        // Pull the method list from the LIVE route table so a new endpoint is
        // covered the moment it is routed, with no test edit.
        const methods = new Set();
        for (const url in explorer.urls.api) {
            const info = explorer.urls.api[url];
            const name = Array.isArray(info) ? info[0] : info;
            if (typeof name === 'string' && typeof db[name] === 'function') methods.add(name);
        }
        expect(methods.size).to.be.at.least(40, 'route table unexpectedly small; canary coverage collapsed');

        const schemaFailures = [];
        const tolerated      = [];
        let executed = 0;
        for (const method of methods) {
            const cfg = makeConfig(Object.assign({ coin: 'RBTC' },
                { data: Object.assign({ method }, PROBE_ARGS[method] || {}) }));
            try {
                await db.getData(cfg);
                executed++;
            } catch (e) {
                if (isSchemaError(e)) {
                    schemaFailures.push(method + ': ' + e.message);
                } else {
                    // Non-schema throws are not schema drift, but they are also
                    // not coverage: the method did not execute SQL. Recorded so
                    // the ratchet below can tell a benign throw from a read path
                    // this rig silently stopped exercising.
                    tolerated.push(method + ': ' + e.message.split('\n')[0]);
                }
            }
        }
        if (tolerated.length) console.log('conformance: tolerated non-schema errors:\n  ' + tolerated.join('\n  '));
        expect(schemaFailures, 'queries disagreeing with the REAL schema:\n' + schemaFailures.join('\n'))
            .to.deep.equal([]);

        // Anti-silent-skip ratchet. A tolerated throw looks identical to a pass
        // in the count above, which is how an unreachable hub and a missing
        // checkpoint schema quietly removed 13 read paths from this tier while
        // it kept printing green. These two patterns mean "the rig is wired
        // wrong", never "the schema is fine", so they fail loudly.
        const rigFailures = tolerated.filter(t =>
            /No co-located hub DB|Hub unreachable|Parameter at position|is not set|ECONNREFUSED/i.test(t));
        expect(rigFailures, 'read paths the conformance rig failed to exercise (harness wiring, not schema):\n' +
            rigFailures.join('\n')).to.deep.equal([]);

        // Guard against a vacuous pass (e.g. every method throwing tolerated
        // config errors would otherwise still be green).
        expect(executed).to.be.at.least(40, 'too few read paths actually executed SQL');
    });
}

// The routed surface, not just the db layer. Every list route in the
// hub-mirrored family is reachable with no {QUERY}/{TYPE} segment, and that
// shape is the one no other tier boots with a checkpoint schema to test: the
// integration fixture has none, so these routes fail their config check there
// long before any SQL runs. A bare cross_chain_matches request answered 500
// here (its `AND m.network = ?` bind was dropped with the phantom search seed)
// on exactly the installs that are configured correctly.
function registerMirroredListRoutes(runtime) {
    it('serves the hub-mirrored list routes with no QUERY/TYPE segment', async function () {
        const { app } = runtime.state;
        const request = require('supertest');
        const routes = [
            '/RBTC/api/cross_chain_matches',
            '/RBTC/api/checkpoints',
            '/RBTC/api/validator_capabilities',
            '/RBTC/api/governance_proposals',
            '/RBTC/api/governance_votes',
            '/RBTC/api/peers',
            '/RBTC/api/consensus_state',
            '/RBTC/api/configs',
            // M3: four more callers of the same bare-request shape. commitments and
            // anchor_reward_attestations carry unconditional checkpointSource
            // placeholders (the exact "phantom search seed drops a real placeholder"
            // risk this test exists for), capability_snapshots binds none, and reorgs
            // binds its own mandatory chain scope.
            '/RBTC/api/commitments',
            '/RBTC/api/anchor_reward_attestations',
            '/RBTC/api/capability_snapshots',
            '/RBTC/api/reorgs'
        ];
        const failures = [];
        for (const route of routes) {
            // A route this build does not expose is not this test's business;
            // 404 means "not routed", anything 5xx means "routed and broken".
            const res = await request(app).get(route);
            if (res.status >= 500) failures.push(route + ' -> ' + res.status + ' ' + JSON.stringify(res.body));
        }
        expect(failures, 'hub-mirrored list routes failing on a correctly configured install:\n' +
            failures.join('\n')).to.deep.equal([]);
    });
}

function registerDetailReads(runtime) {
    it('runs the single-item detail reads without a schema error', async function () {
        const { db } = runtime.state;
        // Point reads the list loop above does not reach (non-getData paths).
        const failures = [];
        const probes = [
            ['getMaxBlockIndex',   () => db.getMaxBlockIndex({ coin: 'RBTC' })],
            ['getMaxActionIndex',  () => db.getMaxActionIndex({ coin: 'RBTC' })],
            ['getBlocksSince',     () => db.getBlocksSince({ coin: 'RBTC' }, 0, 10)],
            ['getActionsSince',    () => db.getActionsSince({ coin: 'RBTC' }, 0, 10)],
            ['checkReorg',         () => db.checkReorgAndInvalidate({ coin: 'RBTC' })],
            ['getActionData',      () => db.getActionData(makeConfig({ coin: 'RBTC' }), 1)],
            ['getAddressId',       () => db.getAddressId(makeConfig({ coin: 'RBTC' }), 'bcrt1qconformance')],
            ['getTickId',          () => db.getTickId(makeConfig({ coin: 'RBTC' }), 'XCHAIN')],
            ['getActionType',      () => db.getActionType(makeConfig({ coin: 'RBTC' }), 1)],
            ['getAddressBalances', () => db.getAddressBalances(makeConfig({ coin: 'RBTC' }), 'bcrt1qconformance')],
            ['getTokenInfo',       () => db.getTokenInfo(makeConfig({ coin: 'RBTC' }), 'XCHAIN')]
        ];
        for (const [name, fn] of probes) {
            try { await fn(); }
            catch (e) {
                if (isSchemaError(e)) failures.push(name + ': ' + e.message);
            }
        }
        expect(failures, failures.join('\n')).to.deep.equal([]);
    });
}

module.exports = { registerRoutedReadPaths, registerMirroredListRoutes, registerDetailReads };
