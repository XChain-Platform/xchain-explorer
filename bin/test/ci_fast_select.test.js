'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const { resolveBase, selectFastTests } = require('../ci_fast_select');

function select(changed, tests = []) {
    return selectFastTests(changed, {
        listTests: () => tests,
        findRequirers: () => []
    });
}

describe('ci fast selector', function() {
    it('selects only a changed test file', function() {
        const changed = 'test/unit/content/pages/content_client_api_endpoints.test.js';
        const other = 'test/unit/config/config.test.js';
        const plan = select([changed], [changed, other]);
        assert.strictEqual(plan.consensus, false);
        assert.deepStrictEqual(plan.tests, [{ group: 'unit', file: changed }]);
    });

    it('widens every explorer consensus prefix', function() {
        for (const file of [
            'src/consensus/merkle.js',
            'src/coins/BTC.js',
            'src/protocol_changes/changes_1.js',
            'bin/pins/at1-explorer-identity.json'
        ]) {
            const plan = select([file]);
            assert.strictEqual(plan.consensus, true, file);
            assert(plan.reasons.includes(`consensus: ${file}`), file);
            assert.deepStrictEqual(plan.tests, []);
        }
    });

    it('selects nothing for documentation alone', function() {
        assert.deepStrictEqual(select(['README.md']), { consensus: false, reasons: [], tests: [] });
    });

    it('widens a package manifest change', function() {
        const plan = select(['package.json']);
        assert.strictEqual(plan.consensus, true);
        assert(plan.reasons.includes('consensus: package.json'));
    });

    it('returns null when neither base can be resolved', function() {
        const stub = (args) => {
            if (args[0] === 'cat-file') throw new Error('unknown commit');
            throw new Error('no merge base');
        };
        assert.strictEqual(resolveBase({ env: { PROM_CI_BASE_SHA: 'unknown' }, git: stub }), null);
    });

    it('returns a push base accepted by git', function() {
        const sha = '0123456789abcdef';
        const calls = [];
        const stub = (args) => {
            calls.push(args);
            return '';
        };
        assert.strictEqual(resolveBase({ env: { PROM_CI_BASE_SHA: sha }, git: stub }), sha);
        assert.deepStrictEqual(calls, [['cat-file', '-e', `${sha}^{commit}`]]);
    });

    it('keeps the fast gate wiring pinned', function() {
        const script = fs.readFileSync('bin/ci-full.sh', 'utf8');
        const planInvocations = script.match(/^.*ci_fast_select\.js --plan.*$/gm) || [];
        assert.deepStrictEqual(planInvocations, [
            '  if FAST_CI_PLAN="$(node bin/ci_fast_select.js --plan 2>&1)"; then'
        ]);
        assert(script.includes(
            'if [ "${CI_TIER:-full}" != "fast" ] || [ "$FAST_CI_PLAN_OK" -eq 0 ]; then\n' +
            '  run_tier "ci" npm run ci\n' +
            'elif printf \'%s\\n\' "$FAST_CI_PLAN" | grep -qx \'consensus 1\'; then\n' +
            '  fast_defer "ci"\n' +
            'else\n' +
            '  run_tier "ci (changed tests)" node bin/ci_fast_select.js --run\n' +
            'fi'
        ));
        assert(script.includes(
            'run_tier "fast-tier selector self-test" ./node_modules/.bin/mocha ' +
            '--no-config --timeout 20000 --exit bin/test/ci_fast_select.test.js'
        ));
    });
});
