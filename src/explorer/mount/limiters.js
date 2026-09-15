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
 * XChain Explorer - the per-route rate limiters
 *
 * Every explorer endpoint that costs more than a table read carries its own bucket
 * rather than the platform default, and each one is built here, beside the others,
 * so the tiers can be read against one another: a quote is looser than a proof, a
 * proof looser than a validator-set recompute.
 *
 * A builder runs at the point the route it caps is mounted, so the construction
 * order a suite counts is the mounting order it always was. Each takes the host bag
 * because the ceilings are read through config.js's env view, which the suites
 * replace in XChainExplorer.js's require map.
 *
 ********************************************************************/

'use strict';

/**
 * The fee-quote bucket, shared by /feequote, /oraclefeequote and /feeschedule.
 */
function buildFeeQuoteLimiter(host){
    const { rateLimit, limitedHandler, configEnv } = host;
    // All three carry a dedicated limiter, not the platform default: each is a
    // JSON-RPC round trip, so an uncapped caller amplifies into a second process.
    // One tier looser than the proof routes, a quote being a lookup rather than a
    // cryptographic recompute.
    //
    // Every limiter below resolves its ceiling, knob name and refusal body into
    // one policy const that is spread into both the limiter and its counter
    // line, so the number an operator reads in the log is the number that
    // actually refused. See src/http/rate_limit_log.js for why the line is throttled.
    const feeQuotePolicy = {
        limit:    parseInt(configEnv().EXPLORER_FEE_QUOTE_RATE_LIMIT_RPM, 10) || 120,
        envVar:   'EXPLORER_FEE_QUOTE_RATE_LIMIT_RPM',
        windowMs: 60 * 1000,
        message:  { error: 'Too many fee requests', code: 'RATE_LIMITED' }
    };
    const feeQuoteLimiter = rateLimit({
        windowMs:        feeQuotePolicy.windowMs,
        limit:           feeQuotePolicy.limit,
        standardHeaders: true,
        legacyHeaders:   false,
        handler:         limitedHandler({ service: 'Explorer', name: 'fee-quote', ...feeQuotePolicy })
    });
    return feeQuoteLimiter;
}

/**
 * The POST pre-flight bucket.
 */
function buildPreflightPostLimiter(host){
    const { rateLimit, limitedHandler, configEnv } = host;
    const preflightPostPolicy = {
        limit:    parseInt(configEnv().EXPLORER_PREFLIGHT_POST_RATE_LIMIT_RPM, 10) || 60,
        envVar:   'EXPLORER_PREFLIGHT_POST_RATE_LIMIT_RPM',
        windowMs: 60 * 1000,
        message:  { error: 'Too many pre-flight requests', code: 'RATE_LIMITED' }
    };
    const preflightPostLimiter = rateLimit({
        windowMs:        preflightPostPolicy.windowMs,
        limit:           preflightPostPolicy.limit,
        standardHeaders: true,
        legacyHeaders:   false,
        handler:         limitedHandler({ service: 'Explorer', name: 'preflight-post', ...preflightPostPolicy })
    });
    return preflightPostLimiter;
}

/**
 * The batch-read bucket, shared by both batch POSTs.
 */
function buildBatchLimiter(host){
    const { rateLimit, limitedHandler, configEnv } = host;
    //
    // One limiter for both routes on purpose: the wallet's balance beat and its
    // coinpay badge are two callers of one wallet, and a single shared bucket is
    // the honest ceiling on what that wallet costs the origin per minute.
    const batchPolicy = {
        limit:    parseInt(configEnv().EXPLORER_BATCH_RATE_LIMIT_RPM, 10) || 72,
        envVar:   'EXPLORER_BATCH_RATE_LIMIT_RPM',
        windowMs: 60 * 1000,
        message:  { error: 'Too many batch requests', code: 'RATE_LIMITED' }
    };
    const batchLimiter = rateLimit({
        windowMs:        batchPolicy.windowMs,
        limit:           batchPolicy.limit,
        standardHeaders: true,
        legacyHeaders:   false,
        handler:         limitedHandler({ service: 'Explorer', name: 'batch', ...batchPolicy })
    });
    return batchLimiter;
}

/**
 * The two checkpoint buckets: the list scan and the heavier server-side verify.
 */
function buildCheckpointLimiters(host){
    const { rateLimit, limitedHandler, configEnv } = host;
    // The list is a hub-mirror scan; verify re-runs Ed25519 once per signature over
    // the qualifying validator set and reads that set's capability snapshot, so it
    // is proof-tier work and takes the tighter of the two caps.
    const checkpointListPolicy = {
        limit:    parseInt(configEnv().EXPLORER_CHECKPOINT_LIST_RATE_LIMIT_RPM, 10) || 120,
        envVar:   'EXPLORER_CHECKPOINT_LIST_RATE_LIMIT_RPM',
        windowMs: 60 * 1000,
        message:  { error: 'Too many checkpoint requests', code: 'RATE_LIMITED' }
    };
    const checkpointListLimiter = rateLimit({
        windowMs:        checkpointListPolicy.windowMs,
        limit:           checkpointListPolicy.limit,
        standardHeaders: true,
        legacyHeaders:   false,
        handler:         limitedHandler({ service: 'Explorer', name: 'checkpoint-list', ...checkpointListPolicy })
    });
    // Verify is 90 rather than the list's 120 because it is the heavier of the
    // pair, and 90 rather than its own former 60 because the wallet's light
    // client issues one /verify per proof job: a five-address wallet's fifteen
    // jobs per session, x2 for the SDK's single retry and x3 for a NAT with
    // three testers, is 90 in the worst minute. The measured wallet profile is
    // the source of that number, not a round guess.
    const checkpointVerifyPolicy = {
        limit:    parseInt(configEnv().EXPLORER_CHECKPOINT_VERIFY_RATE_LIMIT_RPM, 10) || 90,
        envVar:   'EXPLORER_CHECKPOINT_VERIFY_RATE_LIMIT_RPM',
        windowMs: 60 * 1000,
        message:  { error: 'Too many checkpoint verification requests', code: 'RATE_LIMITED' }
    };
    const checkpointVerifyLimiter = rateLimit({
        windowMs:        checkpointVerifyPolicy.windowMs,
        limit:           checkpointVerifyPolicy.limit,
        standardHeaders: true,
        legacyHeaders:   false,
        handler:         limitedHandler({ service: 'Explorer', name: 'checkpoint-verify', ...checkpointVerifyPolicy })
    });
    return { checkpointListLimiter, checkpointVerifyLimiter };
}

/**
 * The two SPV proof buckets.
 */
function buildProofLimiters(host){
    const { rateLimit, limitedHandler, configEnv } = host;
    // SPV light-client proof endpoints (Phase 3, spec §8.1). Read-only: a client
    // recomputes the proof locally and binds it to a quorum-signed checkpoint's
    // committed state_root, never trusting this server's word. Balance, action,
    // validator-set and contract-state proofs plus the checkpoint range are live;
    // contract-state serves a real proof only where the slot is armed at that
    // height, and a typed 409 below it (see the handler).

    // Merkle-proof recompute is CPU-bound per request (it hashes every leaf in the
    // target block), so cap it per-IP well below the platform-wide 1080rpm
    // default, mirroring the VM-call limiter's design.
    //
    // 90, not the former 60: the wallet's balance proof rides this limiter, and a
    // five-address wallet verifies fifteen proofs per session, x2 for the SDK's
    // single retry and x3 for a NAT with three testers. 60 sat below the measured
    // requirement, which only stayed invisible while the bucket keyed on the
    // Cloudflare edge address instead of the client.
    const actionProofPolicy = {
        limit:    parseInt(configEnv().EXPLORER_ACTION_PROOF_RATE_LIMIT_RPM, 10) || 90,
        envVar:   'EXPLORER_ACTION_PROOF_RATE_LIMIT_RPM',
        windowMs: 60 * 1000,
        message:  { error: 'Too many proof requests', code: 'RATE_LIMITED' }
    };
    const actionProofLimiter = rateLimit({
        windowMs:        actionProofPolicy.windowMs,
        limit:           actionProofPolicy.limit,
        standardHeaders: true,
        legacyHeaders:   false,
        handler:         limitedHandler({ service: 'Explorer', name: 'action-proof', ...actionProofPolicy })
    });
    // The validator-set proof is the heaviest endpoint: its handler calls prove
    // once per validator per capability (up to VALIDATOR_QUERY_LIMIT), each a
    // 256-deep SMT descent reading the DB per non-empty level, plus an indexer RPC
    // per capability. Worst case ~2000 descents, so it caps below the action tier.
    const validatorSetProofPolicy = {
        limit:    parseInt(configEnv().EXPLORER_VALIDATOR_SET_PROOF_RATE_LIMIT_RPM, 10) || 30,
        envVar:   'EXPLORER_VALIDATOR_SET_PROOF_RATE_LIMIT_RPM',
        windowMs: 60 * 1000,
        message:  { error: 'Too many proof requests', code: 'RATE_LIMITED' }
    };
    const validatorSetProofLimiter = rateLimit({
        windowMs:        validatorSetProofPolicy.windowMs,
        limit:           validatorSetProofPolicy.limit,
        standardHeaders: true,
        legacyHeaders:   false,
        handler:         limitedHandler({ service: 'Explorer', name: 'validator-set-proof', ...validatorSetProofPolicy })
    });

    return { actionProofLimiter, validatorSetProofLimiter };
}

/**
 * The contract-simulation bucket.
 */
function buildVmQueryLimiter(host){
    const { rateLimit, limitedHandler, configEnv } = host;
    const vmQueryPolicy = {
        limit:    parseInt(configEnv().EXPLORER_VM_QUERY_RATE_LIMIT_RPM, 10) || 20,
        envVar:   'EXPLORER_VM_QUERY_RATE_LIMIT_RPM',
        windowMs: 60 * 1000,
        message:  { error: 'Too many simulation requests', code: 'RATE_LIMITED' }
    };
    const vmQueryLimiter = rateLimit({
        windowMs:        vmQueryPolicy.windowMs,
        limit:           vmQueryPolicy.limit,
        standardHeaders: true,
        legacyHeaders:   false,
        handler:         limitedHandler({ service: 'Explorer', name: 'vm-query', ...vmQueryPolicy })
    });
    return vmQueryLimiter;
}

module.exports = { buildFeeQuoteLimiter, buildPreflightPostLimiter, buildBatchLimiter, buildCheckpointLimiters, buildProofLimiters, buildVmQueryLimiter };
