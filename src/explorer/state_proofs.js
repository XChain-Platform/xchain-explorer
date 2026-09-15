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
 * XChain Explorer - state and contract proofs
 *
 * The proof routes that descend the committed state tree rather than the
 * checkpoint list: action inclusion, the validator set, a contract state key, a
 * locked balance, and the read-only contract call that answers from the same
 * state.
 *
 * Authored as a class body and installed onto XChainExplorer.prototype by
 * explorer/install.js, so `this` is the explorer instance at call time.
 *
 ********************************************************************/

'use strict';

const IndexerConnector = require('../connectors/indexer.js');
const vmQuery          = require('../contract/vm_query.js');
// Module-scope logger, not a method on the class these parts install onto: every
// log line below reaches the shipper api.js installs, exactly as it did inline.
const { getLogger } = require('../observability');
const log = getLogger();

// Upper bound on a contract state key, in UTF-8 BYTES, mirroring the VM's
// maxStateKeySize default (xchain-vm/src/state.js). A key longer than this cannot
// exist in contract_state, so rejecting it here refuses work that could only ever
// miss, and keeps an unbounded path segment from reaching the proof descent.
const CONTRACT_STATE_KEY_MAX_BYTES = 1024;

class StateProofs {

    // A per-row block-content inclusion proof for the action, bound to the signed
    // checkpoint that commits its block's block_merkle_root. block_merkle_root is
    // per-block, so the action's block must itself be checkpointed (D3); a non-
    // checkpointed block returns 409. The client recomputes the root locally.
    async processActionProofRequest(req, res){
        try {
            let coin = String(req.params.coin || '').toUpperCase();
            if(!this.db.pools || !this.db.pools[coin])
                return res.status(404).json({ error: 'Unknown coin', code: 'UNKNOWN_COIN' });
            // Action proofs bind to a quorum-signed checkpoint read from the mirror,
            // so they inherit the same staleness gate as the balance-proof/checkpoint
            // routes: on a never-bootstrapped or stale self-synced mirror they must 503
            // rather than answer an authoritative "not checkpointed" (409) off an
            // empty/frozen mirror.
            let gate = this.mirrorGate(coin);
            if(gate.blocked)
                return res.status(503).json(this.mirrorBlockedBody(gate.blocked));
            let parsed = this.parseCoinCode(coin, await this.configInfo.getConfig());
            if(!parsed)
                return res.status(404).json({ error: 'Unknown coin', code: 'UNKNOWN_COIN' });
            let actionIndex = req.params.actionIndex;
            if(!/^[0-9]+$/.test(String(actionIndex)))
                return res.status(400).json({ error: 'Invalid action index', code: 'INVALID_ACTION_INDEX' });
            let config = { coin, data: {} };
            let result = await this.proofServer.actionProof(config, parsed.coin, parsed.network, Number(actionIndex));
            if(result.error){
                let map = { ACTION_NOT_FOUND: [404, 'No such action on this server'],
                            ACTION_BLOCK_NOT_CHECKPOINTED: [409, 'The action\'s block is not checkpointed (no signed block_merkle_root to bind to)'],
                            CHECKPOINT_PRE_COMMITMENT: [409, 'Checkpoint predates the state-commitment flag-day (no committed roots)'],
                            NO_STATE_TREE: [501, 'This server does not hold the state tree (point a full indexer DB at the proof server)'],
                            ACTION_LEAF_NOT_FOUND: [500, 'Action row not present in its block leaf set'],
                            PROOF_BLOCK_MERKLE_MISMATCH: [500, 'Committed block_merkle_root does not match the local block tree'] };
                let m = map[result.error] || [500, 'Server error'];
                return res.status(m[0]).json({ error: m[1], code: result.error });
            }
            return res.json(result);
        } catch(e){
            log.error('ACTION_PROOF_REQUEST_FAILED', { err: e && e.message });
            return res.status(500).json({ error: 'Server error', code: 'SERVER_ERROR' });
        }
    }

    // GET /{COIN}/api/proof/validator-set?height=<btc_snapshot>  (SPV spec §7.2/§8.1)
    // Proves the oracle_publish/cross_chain signer set + weights + source-deduped total
    // at BTC snapshot height S, bound to the BTC checkpoint at block_index == S. BTC-only.
    async processValidatorSetProofRequest(req, res){
        try {
            let coin = String(req.params.coin || '').toUpperCase();
            if(!this.db.pools || !this.db.pools[coin])
                return res.status(404).json({ error: 'Unknown coin', code: 'UNKNOWN_COIN' });
            // Validator-set proofs bind to the BTC checkpoint at the snapshot height,
            // read from the mirror, so they inherit the same staleness gate as the
            // balance-proof/checkpoint routes (503 on an unbootstrapped/stale mirror
            // instead of an authoritative "not yet checkpointed" 409 off a frozen mirror).
            let gate = this.mirrorGate(coin);
            if(gate.blocked)
                return res.status(503).json(this.mirrorBlockedBody(gate.blocked));
            let parsed = this.parseCoinCode(coin, await this.configInfo.getConfig());
            if(!parsed)
                return res.status(404).json({ error: 'Unknown coin', code: 'UNKNOWN_COIN' });
            if(parsed.coin !== 'BTC')
                return res.status(400).json({ error: 'validator-set proof is BTC-only (stakes_root is BTC-only)', code: 'STAKES_BTC_ONLY' });
            let height = req.query.height;
            if(!/^[0-9]+$/.test(String(height)))
                return res.status(400).json({ error: 'height (BTC snapshot block) is required', code: 'INVALID_HEIGHT' });
            let url = IndexerConnector.resolveIndexerUrl(parsed.coin, parsed.network);
            if(!url)
                return res.status(501).json({ error: 'validator-set proof unavailable (indexer API not configured for ' + parsed.coin + '/' + parsed.network + ')', code: 'INDEXER_NOT_CONFIGURED' });
            let connector = new IndexerConnector(url);
            let config = { coin, data: {} };
            let result = await this.proofServer.validatorSetProof(config, parsed.coin, parsed.network, Number(height), connector);
            if(result.error){
                let map = { STAKES_BTC_ONLY: [400, 'validator-set proof is BTC-only'],
                            SNAPSHOT_NOT_YET_CHECKPOINTED: [409, 'No BTC checkpoint at this snapshot height yet (retry after the chain advances)'],
                            CHECKPOINT_PRE_COMMITMENT: [409, 'Checkpoint predates the state-commitment flag-day (no committed roots)'],
                            NO_STATE_TREE: [501, 'This server does not hold the state tree (point a full indexer DB at the proof server)'],
                            INDEXER_UNAVAILABLE: [502, 'Indexer API unavailable for the stake set'],
                            INDEXER_AUTH_REQUIRED: [503, 'Indexer requires authentication for the stake set; set EXPLORER_INDEXER_API_KEY on the explorer'],
                            PROOF_STATE_ROOT_MISMATCH: [500, 'Committed state_root does not match the local state tree'],
                            STAKE_SNAPSHOT_TRUNCATED: [409, 'Stake snapshot at this height is truncated (the qualifying validator set overflowed the indexer query cap); no proof is served until operators raise the cap'],
                            STAKE_SNAPSHOT_MALFORMED: [500, 'Stake snapshot at this height is malformed'] };
                // Match the PREFIX before the first ':'. The stake-snapshot errors carry a
                // ':<capability>[:<detail>]' suffix that no exact-match row can hit, so they
                // fall through to the generic 500 and echo the raw suffix, exception text
                // included, back to the client in `code`. Every other code here is
                // suffix-free, so its prefix is the whole string and its response is byte-identical.
                let code = String(result.error).split(':')[0];
                let m = map[code] || [500, 'Server error'];
                return res.status(m[0]).json({ error: m[1], code: code });
            }
            return res.json(result);
        } catch(e){
            log.error('VALIDATOR_SET_PROOF_REQUEST_FAILED', { err: e && e.message });
            return res.status(500).json({ error: 'Server error', code: 'SERVER_ERROR' });
        }
    }

    // GET /{COIN}/api/proof/contract-state/{contractIndex}/{key}?height=H (SPV §8.1)
    // Serves a real proof where contract_state_root is armed and a typed 409 below
    // them, an inert slot's EMPTY tree otherwise "proving" every key absent.

    // EVERY INPUT RULE BELOW RUNS BEFORE THE KEY REACHES ANY CRYPTO PRIMITIVE:
    // merkle.joinFields THROWS on a 0x00-bearing field, so a hostile `%00` segment
    // would surface as a 500 from an unauthenticated request. Each rule is a 400 with
    // its own code, and none of them decode: Express rejects a malformed escape first.
    async processContractStateProofRequest(req, res){
        try {
            let coin = String(req.params.coin || '').toUpperCase();
            if(!this.db.pools || !this.db.pools[coin])
                return res.status(404).json({ error: 'Unknown coin', code: 'UNKNOWN_COIN' });
            // Same staleness gate as every other checkpoint-bound proof route.
            let gate = this.mirrorGate(coin);
            if(gate.blocked)
                return res.status(503).json(this.mirrorBlockedBody(gate.blocked));
            let parsed = this.parseCoinCode(coin, await this.configInfo.getConfig());
            if(!parsed)
                return res.status(404).json({ error: 'Unknown coin', code: 'UNKNOWN_COIN' });

            let contractIndex = String(req.params.contractIndex || '');
            if(!/^[0-9]+$/.test(contractIndex))
                return res.status(400).json({ error: 'contractIndex must be a non-negative integer',
                                              code: 'INVALID_CONTRACT_INDEX' });

            // Express decodes :key already, so this must NOT decode again: a second
            // decodeURIComponent corrupts every key holding a percent sign (`a%2541b`
            // arrives as `a%41b` and becomes `aAb`, proving the WRONG KEY) and throws
            // on one ending in a bare `%`. Express rejects a malformed escape itself.
            let key = req.params.key;
            if(key === undefined || key === null || key === '')
                return res.status(400).json({ error: 'state key is required', code: 'MISSING_PARAMETER' });
            key = String(key);
            if(key.indexOf('\u0000') !== -1)
                return res.status(400).json({ error: 'state key may not contain a NUL byte',
                                              code: 'INVALID_KEY_NUL' });
            // Mirrors the VM's maxStateKeySize default (xchain-vm state.js), measured
            // in UTF-8 BYTES because that is what the VM measures and what the column
            // stores. A longer key cannot exist in contract_state, so this rejects
            // work that could only ever miss.
            if(Buffer.byteLength(key, 'utf8') > CONTRACT_STATE_KEY_MAX_BYTES)
                return res.status(400).json({ error: 'state key exceeds ' + CONTRACT_STATE_KEY_MAX_BYTES + ' bytes',
                                              code: 'KEY_TOO_LONG' });

            let height = (req.query.height !== undefined && req.query.height !== '') ? req.query.height : null;
            if(height !== null && !/^[0-9]+$/.test(String(height)))
                return res.status(400).json({ error: 'Invalid height', code: 'INVALID_HEIGHT' });

            let config = { coin, data: {} };
            let result = await this.proofServer.contractStateProof(config, parsed.coin, parsed.network,
                                                                   contractIndex, key,
                                                                   height === null ? null : Number(height));
            if(result.error){
                let map = { NO_CHECKPOINT: [404, 'No signed checkpoint at or above this height'],
                            CHECKPOINT_PRE_COMMITMENT: [409, 'Checkpoint predates the state-commitment flag-day (no committed roots)'],
                            CONTRACT_STATE_NOT_COMMITTED: [409, 'contract_state_root is not committed at this height (the slot is EMPTY here, so absence cannot be proven)'],
                            NO_STATE_TREE: [501, 'This server does not hold the state tree (point a full indexer DB at the proof server)'],
                            PROOF_STATE_ROOT_MISMATCH: [500, 'Committed state_root does not match the local state tree'] };
                let m = map[result.error] || [500, 'Server error'];
                return res.status(m[0]).json({ error: m[1], code: result.error });
            }
            return res.json(result);
        } catch(e){
            log.error('CONTRACT_STATE_PROOF_REQUEST_FAILED', { err: e && e.message });
            return res.status(500).json({ error: 'Server error', code: 'SERVER_ERROR' });
        }
    }

    // GET /{COIN}/api/proof/locked-balance/{address}/{tick}?height=H
    // (SPV sub-tree spec §3 Stage B)

    // The XCHAIN_ESC sibling of the balance proof: same params, response shape and
    // checkpoint binding, PLUS a liveness refusal. Below the escrow leaf's armed
    // height a non-inclusion proof would verify against a balances_root that never
    // covered the domain, so the endpoint answers a typed 409 rather than "proving"
    // that nothing is locked.
    async processLockedBalanceProofRequest(req, res){
        try {
            let coin = String(req.params.coin || '').toUpperCase();
            if(!this.db.pools || !this.db.pools[coin])
                return res.status(404).json({ error: 'Unknown coin', code: 'UNKNOWN_COIN' });
            // Same staleness gate as every other checkpoint-bound proof route.
            let gate = this.mirrorGate(coin);
            if(gate.blocked)
                return res.status(503).json(this.mirrorBlockedBody(gate.blocked));
            let parsed = this.parseCoinCode(coin, await this.configInfo.getConfig());
            if(!parsed)
                return res.status(404).json({ error: 'Unknown coin', code: 'UNKNOWN_COIN' });
            let address = String(req.params.address || '');
            let tick    = String(req.params.tick || '');
            if(!address || !tick)
                return res.status(400).json({ error: 'address and tick are required', code: 'MISSING_PARAMETER' });
            let height = (req.query.height !== undefined && req.query.height !== '') ? req.query.height : null;
            if(height !== null && !/^[0-9]+$/.test(String(height)))
                return res.status(400).json({ error: 'Invalid height', code: 'INVALID_HEIGHT' });
            let config = { coin, data: {} };
            let result = await this.proofServer.lockedBalanceProof(config, parsed.coin, parsed.network, address, tick,
                                                                   height === null ? null : Number(height));
            if(result.error){
                let map = { NO_CHECKPOINT: [404, 'No signed checkpoint at or above this height'],
                            CHECKPOINT_PRE_COMMITMENT: [409, 'Checkpoint predates the state-commitment flag-day (no committed roots)'],
                            ESCROW_LEAF_NOT_COMMITTED: [409, 'The locked-balance leaf is not committed at this height (balances_root does not cover the XCHAIN_ESC domain here, so absence cannot be proven)'],
                            NO_STATE_TREE: [501, 'This server does not hold the state tree (point a full indexer DB at the proof server)'],
                            PROOF_STATE_ROOT_MISMATCH: [500, 'Committed state_root does not match the local state tree'] };
                let m = map[result.error] || [500, 'Server error'];
                return res.status(m[0]).json({ error: m[1], code: result.error });
            }
            return res.json(result);
        } catch(e){
            log.error('LOCKED_BALANCE_PROOF_REQUEST_FAILED', { err: e && e.message });
            return res.status(500).json({ error: 'Server error', code: 'SERVER_ERROR' });
        }
    }

    // POST /{COIN}/api/contract/{contractIndex}/call  body: {method, params?, caller?}
    // Read-only simulation of a contract method against current state (see
    // contract/vm_query.js). Contract-level failures (unknown method, revert, gas) come
    // back as success:false in a 200 body, exactly as the VM reports them;
    // request/infra failures map to typed HTTP errors.
    async processContractCallRequest(req, res){
        try {
            let coin = String(req.params.coin || '').toUpperCase();
            if(!this.db.pools || !this.db.pools[coin])
                return res.status(404).json({ error: 'Unknown coin', code: 'UNKNOWN_COIN' });
            let parsed = this.parseCoinCode(coin, await this.configInfo.getConfig());
            if(!parsed)
                return res.status(404).json({ error: 'Unknown coin', code: 'UNKNOWN_COIN' });
            let contractIndex = req.params.contractIndex;
            if(!/^[0-9]+$/.test(String(contractIndex)))
                return res.status(400).json({ error: 'Invalid contract index', code: 'INVALID_CONTRACT_INDEX' });

            // Same freshness contract as the catch-all data routes. This route is
            // hand-registered ahead of the catch-all, so it never passes through
            // processRequest; a simulation reads MUTABLE contract state, so it carries
            // the same marker (and the same fail-closed opt-in) rather than answering
            // a "current state" question with nothing said about how current.
            let simTipStale = await this.db.isCoinTipStale(coin);
            if(simTipStale && this.db.staleFailClosed && this.db.staleFailClosed())
                return res.status(503).json({
                    error: 'Indexed data for this coin is stale beyond its maximum tip age; refusing to serve it as current.',
                    code: 'COIN_DATA_STALE'
                });
            res.set('XChain-Freshness', simTipStale ? 'stale' : 'live');

            let config = { coin, data: {} };
            let result = await vmQuery.simulate(this.db, config, Number(contractIndex), req.body || {}, parsed.coin, parsed.network, req.ip);

            // Effects live under `simulation` with an explicit disclaimer so no
            // client can mistake a would-be write for an on-chain one.
            return res.json({
                success:     result.success,
                error:       result.error,
                gasUsed:     result.gasUsed,
                returnValue: result.returnValue,
                logs:        result.logs,
                simulation: {
                    note:           'read-only preview; nothing was committed on-chain',
                    stateChanges:   result.stateChanges,
                    stateDeletes:   result.stateDeletes,
                    emittedActions: result.emittedActions
                }
            });
        } catch(e){
            if(e && e.code && e.httpStatus)
                return res.status(e.httpStatus).json({ error: e.message, code: e.code });
            log.error('CONTRACT_CALL_REQUEST_FAILED', { err: e && e.message });
            return res.status(500).json({ error: 'Server error', code: 'SERVER_ERROR' });
        }
    }
}

module.exports = { methods: StateProofs.prototype };
