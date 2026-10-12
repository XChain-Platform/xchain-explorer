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
 *
 * Unit tests for the per-route rate limiter builders, called directly with a
 * fake host so each limiter's ceiling, env knob and refusal body is pinned.
 *
 *********************************************************************/

'use strict';

const { expect } = require('chai');
const sinon      = require('sinon');

const limiters = require('../../../../src/explorer/mount/limiters.js');

const SPECS = [
    { label: 'fee-quote',           build: 'buildFeeQuoteLimiter',    pick: null,                       name: 'fee-quote',           envVar: 'EXPLORER_FEE_QUOTE_RATE_LIMIT_RPM',           limit: 120, error: 'Too many fee requests' },
    { label: 'preflight-post',      build: 'buildPreflightPostLimiter', pick: null,                     name: 'preflight-post',      envVar: 'EXPLORER_PREFLIGHT_POST_RATE_LIMIT_RPM',      limit: 60,  error: 'Too many pre-flight requests' },
    { label: 'batch',               build: 'buildBatchLimiter',       pick: null,                       name: 'batch',               envVar: 'EXPLORER_BATCH_RATE_LIMIT_RPM',               limit: 72,  error: 'Too many batch requests' },
    { label: 'checkpoint-list',     build: 'buildCheckpointLimiters', pick: 'checkpointListLimiter',    name: 'checkpoint-list',     envVar: 'EXPLORER_CHECKPOINT_LIST_RATE_LIMIT_RPM',     limit: 120, error: 'Too many checkpoint requests' },
    { label: 'checkpoint-verify',   build: 'buildCheckpointLimiters', pick: 'checkpointVerifyLimiter',  name: 'checkpoint-verify',   envVar: 'EXPLORER_CHECKPOINT_VERIFY_RATE_LIMIT_RPM',   limit: 60,  error: 'Too many checkpoint verification requests' },
    { label: 'action-proof',        build: 'buildProofLimiters',      pick: 'actionProofLimiter',       name: 'action-proof',        envVar: 'EXPLORER_ACTION_PROOF_RATE_LIMIT_RPM',        limit: 90,  error: 'Too many proof requests' },
    { label: 'validator-set-proof', build: 'buildProofLimiters',      pick: 'validatorSetProofLimiter', name: 'validator-set-proof', envVar: 'EXPLORER_VALIDATOR_SET_PROOF_RATE_LIMIT_RPM', limit: 30,  error: 'Too many proof requests' },
    { label: 'vm-query',            build: 'buildVmQueryLimiter',     pick: null,                       name: 'vm-query',            envVar: 'EXPLORER_VM_QUERY_RATE_LIMIT_RPM',            limit: 20,  error: 'Too many simulation requests' }
];

// Each rateLimit call returns its own marker so a limiter wired to the wrong
// call is distinguishable from a correct one.
function makeHost(env){
    const calls = [];
    const rateLimit = sinon.stub().callsFake(options => {
        const marker = { marker: calls.length, options };
        calls.push(marker);
        return marker;
    });
    const limitedHandler = sinon.stub().callsFake(input => ({ handlerFor: input.name }));
    const configEnv = sinon.stub().returns(env);
    return { host: { rateLimit, limitedHandler, configEnv }, rateLimit, limitedHandler, calls };
}

function run(spec, env){
    const ctx = makeHost(env);
    const built = limiters[spec.build](ctx.host);
    const limiter = spec.pick ? built[spec.pick] : built;
    const matching = ctx.limitedHandler.getCalls().map(c => c.args[0]).filter(a => a.name === spec.name);
    return { ...ctx, built, limiter, handlerInput: matching[0], handlerCallCount: matching.length };
}

function addFallbackTests(spec){
    [['0', '0'], ['abc', 'abc'], ['empty', '']].forEach(([title, value]) => {
        it(`falls back to the default for ${title}`, function(){
            const { handlerInput, limiter } = run(spec, { [spec.envVar]: value });
            expect(limiter.options.limit).to.equal(spec.limit);
            expect(handlerInput.limit).to.equal(spec.limit);
        });
    });
}

function addLimiterTests(spec){
    describe(spec.label, function(){
        it('returns the rateLimit marker for its own call', function(){
            const r = run(spec, {});
            expect(r.limiter).to.be.an('object');
            expect(r.calls).to.include(r.limiter);
            expect(r.limiter.options.handler).to.deep.equal({ handlerFor: spec.name });
        });

        it('passes the window, header flags and handler to rateLimit', function(){
            const { limiter } = run(spec, {});
            expect(limiter.options).to.include({ windowMs: 60000, standardHeaders: true, legacyHeaders: false });
            expect(limiter.options.handler).to.deep.equal({ handlerFor: spec.name });
        });

        it('hands limitedHandler the policy with the default limit', function(){
            const { handlerInput, limiter } = run(spec, {});
            expect(handlerInput).to.deep.equal({
                service: 'Explorer', name: spec.name, envVar: spec.envVar, windowMs: 60000,
                limit: spec.limit, message: { error: spec.error, code: 'RATE_LIMITED' }
            });
            expect(limiter.options.limit).to.equal(spec.limit);
        });

        it('calls limitedHandler exactly once for its name', function(){
            const r = run(spec, {});
            expect(r.handlerCallCount).to.equal(1);
            expect(r.limitedHandler.callCount).to.equal(r.rateLimit.callCount);
        });

        it('takes the limit from its env knob when positive', function(){
            const { handlerInput, limiter } = run(spec, { [spec.envVar]: '7' });
            expect(limiter.options.limit).to.equal(7);
            expect(handlerInput.limit).to.equal(7);
        });

        addFallbackTests(spec);
    });
}

describe('explorer mount limiters', function(){
    SPECS.forEach(addLimiterTests);

    it('returns both checkpoint limiters under their names', function(){
        const { built } = run(SPECS[3], {});
        expect(built).to.have.all.keys('checkpointListLimiter', 'checkpointVerifyLimiter');
    });

    it('returns both proof limiters under their names', function(){
        const { built } = run(SPECS[5], {});
        expect(built).to.have.all.keys('actionProofLimiter', 'validatorSetProofLimiter');
    });

    it('does not let one limiter env knob move another', function(){
        const { built } = run(SPECS[3], { EXPLORER_CHECKPOINT_VERIFY_RATE_LIMIT_RPM: '5' });
        expect(built.checkpointListLimiter.options.limit).to.equal(120);
        expect(built.checkpointVerifyLimiter.options.limit).to.equal(5);
    });
});
