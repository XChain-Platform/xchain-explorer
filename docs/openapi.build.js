#!/usr/bin/env node
/*
 * Copyright © 2025–2026 Dankest, LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * Licensed under the GNU Affero GPL v3.0 or later; see LICENSE.md.
 * A commercial license is available - contact legal@dankest.llc.
 *
 * Generates docs/openapi.json (OpenAPI 3.1) for the explorer's public REST API.
 *
 * ROUTES below deliberately mirrors the `api` table in src/XChainExplorer.js
 * key-for-key (same path templates, same {TYPE} enums) plus the special
 * pre-wildcard routes registered in setupUrls(). The unit test
 * test/unit/openapi-coverage.test.js fails if the two drift apart, so edits to
 * either side must land together. The /{COIN}/explorer/* datatable routes are
 * an internal surface for the web UI and are intentionally NOT documented.
 *
 * Run: node docs/openapi.build.js   (regenerates docs/openapi.json in place)
 */
const fs = require('fs');
const path = require('path');

const COINS = ['BTC', 'TBTC', 'RBTC', 'LTC', 'TLTC', 'RLTC', 'DOGE', 'TDOGE', 'RDOGE'];

// path, db method, {TYPE} enum (array) / fixed QUERY kind (string) / none, tag, summary
const ROUTES = [
    // ── Action history ────────────────────────────────────────────────────
    ['/{COIN}/api/addresses/{QUERY}/{TYPE}', 'getAddresses', ['block', 'address'], 'Action history', 'ADDRESS actions (address registrations)'],
    ['/{COIN}/api/airdrops/{QUERY}/{TYPE}', 'getAirdrops', ['block', 'address', 'token'], 'Action history', 'AIRDROP actions'],
    ['/{COIN}/api/batches/{QUERY}/{TYPE}', 'getBatches', ['block', 'address'], 'Action history', 'BATCH actions'],
    ['/{COIN}/api/broadcasts/{QUERY}/{TYPE}', 'getBroadcasts', ['block', 'address'], 'Action history', 'BROADCAST actions'],
    ['/{COIN}/api/callbacks/{QUERY}/{TYPE}', 'getCallbacks', ['block', 'address', 'token'], 'Action history', 'CALLBACK actions'],
    ['/{COIN}/api/destroys/{QUERY}/{TYPE}', 'getDestroys', ['block', 'address', 'token'], 'Action history', 'DESTROY actions (token burns)'],
    ['/{COIN}/api/dividends/{QUERY}/{TYPE}', 'getDividends', ['block', 'address', 'token'], 'Action history', 'DIVIDEND actions'],
    ['/{COIN}/api/dispensers/{QUERY}/{TYPE}', 'getDispensers', ['block', 'address', 'source', 'destination', 'token', 'oracle'], 'Dispensers', 'DISPENSER actions (vending machines)'],
    ['/{COIN}/api/dispenser_cancels/{QUERY}/{TYPE}', 'getDispenserCancels', ['block', 'address'], 'Dispensers', 'Dispenser cancellations'],
    ['/{COIN}/api/dispenser_closes/{QUERY}/{TYPE}', 'getDispenserCloses', ['block', 'address'], 'Dispensers', 'Dispenser closes'],
    ['/{COIN}/api/dispenser_expires/{QUERY}/{TYPE}', 'getDispenserExpires', ['block', 'address'], 'Dispensers', 'Dispenser expirations'],
    ['/{COIN}/api/dispenser_edits/{QUERY}/{TYPE}', 'getDispenserEdits', ['block', 'address'], 'Dispensers', 'Dispenser edits'],
    ['/{COIN}/api/dispenses/{QUERY}/{TYPE}', 'getDispenses', ['block', 'address', 'source', 'destination', 'token', 'dispenser'], 'Dispensers', 'Dispenses (vending events: coin in, tokens out)'],
    ['/{COIN}/api/fees/{QUERY}/{TYPE}', 'getFees', ['block', 'address', 'source', 'destination', 'token'], 'Action history', 'Protocol fee payments'],
    ['/{COIN}/api/files/{QUERY}/{TYPE}', 'getFiles', ['block', 'address', 'token'], 'Files', 'FILE actions (on-chain files, incl. token-gated)'],
    ['/{COIN}/api/issues/{QUERY}/{TYPE}', 'getIssues', ['block', 'address', 'token'], 'Tokens', 'ISSUE actions (token issuances)'],
    ['/{COIN}/api/links/{QUERY}/{TYPE}', 'getLinks', ['block', 'address'], 'Action history', 'LINK actions'],
    ['/{COIN}/api/lists/{QUERY}/{TYPE}', 'getLists', ['block', 'address'], 'Action history', 'LIST actions'],
    ['/{COIN}/api/messages/{QUERY}/{TYPE}', 'getMessages', ['block', 'address', 'source', 'destination'], 'Action history', 'MESSAGE actions (encrypted messaging)'],
    ['/{COIN}/api/mints/{QUERY}/{TYPE}', 'getMints', ['block', 'address', 'source', 'destination', 'token'], 'Tokens', 'MINT actions'],
    ['/{COIN}/api/orders/{QUERY}/{TYPE}', 'getOrders', ['block', 'address', 'token'], 'Markets', 'ORDER actions (DEX orders)'],
    ['/{COIN}/api/order_expires/{QUERY}/{TYPE}', 'getOrderExpires', ['block', 'address'], 'Markets', 'Order expirations'],
    ['/{COIN}/api/order_edits/{QUERY}/{TYPE}', 'getOrderEdits', ['block', 'address'], 'Markets', 'Order edits'],
    ['/{COIN}/api/order_cancels/{QUERY}/{TYPE}', 'getOrderCancels', ['block', 'address'], 'Markets', 'Order cancellations'],
    ['/{COIN}/api/order_matches/{QUERY}/{TYPE}', 'getOrderMatches', ['block'], 'Markets', 'Order matches (fills), filtered'],
    ['/{COIN}/api/order_matches', 'getOrderMatches', null, 'Markets', 'Order matches (fills)'],
    ['/{COIN}/api/coinpays/{QUERY}/{TYPE}', 'getCoinpays', ['block', 'address'], 'Markets', 'COINPAY actions (native-coin payment legs)'],
    ['/{COIN}/api/coinpay_expires/{QUERY}/{TYPE}', 'getCoinpayExpires', ['block', 'address'], 'Markets', 'COINPAY expirations'],
    ['/{COIN}/api/coinpay_obligations/{QUERY}/{TYPE}', 'getCoinpayObligations', ['block', 'address'], 'Markets', 'Open COINPAY obligations'],
    ['/{COIN}/api/sends/{QUERY}/{TYPE}', 'getSends', ['block', 'address', 'source', 'destination', 'token'], 'Action history', 'SEND actions (token transfers)'],
    ['/{COIN}/api/sleeps/{QUERY}/{TYPE}', 'getSleeps', ['block', 'address', 'token'], 'Action history', 'SLEEP actions'],
    ['/{COIN}/api/swaps/{QUERY}/{TYPE}', 'getSwaps', ['block', 'address', 'token'], 'Markets', 'SWAP actions (peer-to-peer swaps)'],
    ['/{COIN}/api/swap_edits/{QUERY}/{TYPE}', 'getSwapEdits', ['block', 'address'], 'Markets', 'Swap edits'],
    ['/{COIN}/api/swap_expires/{QUERY}/{TYPE}', 'getSwapExpires', ['block', 'address'], 'Markets', 'Swap expirations'],
    ['/{COIN}/api/swap_cancels/{QUERY}/{TYPE}', 'getSwapCancels', ['block', 'address'], 'Markets', 'Swap cancellations'],
    ['/{COIN}/api/swap_matches/{QUERY}/{TYPE}', 'getSwapMatches', ['block'], 'Markets', 'Swap matches, filtered'],
    ['/{COIN}/api/swap_matches', 'getSwapMatches', null, 'Markets', 'Swap matches'],
    ['/{COIN}/api/sweeps/{QUERY}/{TYPE}', 'getSweeps', ['block', 'address', 'source', 'destination'], 'Action history', 'SWEEP actions'],
    // ── Prices ────────────────────────────────────────────────────────────
    ['/{COIN}/api/prices/{QUERY}/{TYPE}', 'getPrices', ['block', 'address', 'source', 'token'], 'Prices', 'PRICE oracle rows, filtered'],
    ['/{COIN}/api/prices', 'getPrices', null, 'Prices', 'PRICE oracle rows (validator COIN/FIAT + user TOKEN/FIAT)'],
    ['/{COIN}/api/price_snapshots/{QUERY}/{TYPE}', 'getPriceSnapshots', ['pair', 'round', 'status'], 'Prices', 'Federation price snapshots, filtered'],
    ['/{COIN}/api/price_snapshots', 'getPriceSnapshots', null, 'Prices', 'Federation price snapshots (PBFT-finalized rounds)'],
    ['/{COIN}/api/controllers', 'getControllers', null, 'Tokens', 'Controller bind/unbind events (programmable-policy guards on tokens + addresses)'],
    // ── Contracts ─────────────────────────────────────────────────────────
    ['/{COIN}/api/contracts/{QUERY}/{TYPE}', 'getContracts', ['block', 'address', 'source'], 'Contracts', 'Deployed contracts, filtered'],
    ['/{COIN}/api/contracts', 'getContracts', null, 'Contracts', 'Deployed smart contracts'],
    ['/{COIN}/api/contract/{QUERY}', 'getContract', 'contract', 'Contracts', 'One contract (by action index)'],
    ['/{COIN}/api/contract/{QUERY}/state', 'getContractState', 'contract', 'Contracts', 'Contract state (all keys)'],
    ['/{COIN}/api/contract/{QUERY}/state/{TYPE}', 'getContractState', 'contract', 'Contracts', 'Contract state (one key)'],
    ['/{COIN}/api/contract/{QUERY}/balance', 'getContractBalance', 'contract', 'Contracts', 'Contract token balances'],
    ['/{COIN}/api/contract/{QUERY}/balance/{TYPE}', 'getContractBalance', 'contract', 'Contracts', 'Contract balance (one tick)'],
    ['/{COIN}/api/executions/{QUERY}/{TYPE}', 'getExecutions', ['block', 'address', 'contract'], 'Contracts', 'Contract executions, filtered'],
    ['/{COIN}/api/executions', 'getExecutions', null, 'Contracts', 'Contract executions'],
    ['/{COIN}/api/execution/{QUERY}', 'getExecution', 'execution', 'Contracts', 'One execution (by action index)'],
    ['/{COIN}/api/deploy_chunks', 'getDeployChunks', null, 'Contracts', 'Chunked DEPLOY (v4) carriers'],
    ['/{COIN}/api/deposits/{QUERY}/{TYPE}', 'getDeposits', ['block', 'address', 'source', 'contract'], 'Contracts', 'Contract deposits'],
    ['/{COIN}/api/withdrawals/{QUERY}/{TYPE}', 'getWithdrawals', ['block', 'address', 'source', 'contract'], 'Contracts', 'Contract withdrawals'],
    // ── Staking ───────────────────────────────────────────────────────────
    ['/{COIN}/api/stakes/{QUERY}/{TYPE}', 'getStakes', ['block', 'address', 'source'], 'Staking', 'Capability stakes, filtered'],
    ['/{COIN}/api/stakes', 'getStakes', null, 'Staking', 'Capability stakes (validator staking)'],
    ['/{COIN}/api/validators', 'getValidators', null, 'Staking', 'Active validators and their capabilities'],
    ['/{COIN}/api/delegations/{QUERY}/{TYPE}', 'getDelegations', ['block', 'address', 'source'], 'Staking', 'Signing-key delegations'],
    ['/{COIN}/api/rewards/{QUERY}/{TYPE}', 'getValidatorRewards', ['address', 'source'], 'Staking', 'Validator rewards (oracle/anchor/attestation)'],
    ['/{COIN}/api/full_node_verifications/{QUERY}/{TYPE}', 'getFullNodeVerifications', ['block', 'epoch', 'pubkey', 'address'], 'Staking', 'Full-node possession-proof verdicts (NODEPROOF v0), filtered'],
    ['/{COIN}/api/full_node_verifications', 'getFullNodeVerifications', null, 'Staking', 'Full-node possession-proof verdicts (NODEPROOF v0)'],
    ['/{COIN}/api/contract_stakes/{QUERY}/{TYPE}', 'getContractStakes', ['block', 'address', 'contract'], 'Staking', 'Contract-targeted stakes, filtered'],
    ['/{COIN}/api/contract_stakes', 'getContractStakes', null, 'Staking', 'Contract-targeted stakes (STAKE v3)'],
    ['/{COIN}/api/contract_unstakes/{QUERY}/{TYPE}', 'getContractUnstakes', ['block', 'address', 'contract'], 'Staking', 'Contract unstakes, filtered'],
    ['/{COIN}/api/contract_unstakes', 'getContractUnstakes', null, 'Staking', 'Contract unstakes (UNSTAKE v1)'],
    ['/{COIN}/api/contract_delegations/{QUERY}/{TYPE}', 'getContractDelegations', ['block', 'address', 'contract'], 'Staking', 'Contract-stake delegations, filtered'],
    ['/{COIN}/api/contract_delegations', 'getContractDelegations', null, 'Staking', 'Contract-stake delegations'],
    ['/{COIN}/api/slash_events/{QUERY}/{TYPE}', 'getSlashEvents', ['block', 'address', 'contract'], 'Staking', 'Slash events, filtered'],
    ['/{COIN}/api/slash_events', 'getSlashEvents', null, 'Staking', 'Slash events'],
    ['/{COIN}/api/unstakes/{QUERY}/{TYPE}', 'getUnstakes', ['block', 'address', 'source'], 'Staking', 'Capability unstakes, filtered'],
    ['/{COIN}/api/unstakes', 'getUnstakes', null, 'Staking', 'Capability unstakes (UNSTAKE v0)'],
    ['/{COIN}/api/delegation_revocations/{QUERY}/{TYPE}', 'getStakeKeyRevocations', ['block', 'address', 'source'], 'Staking', 'Signing-key revocations, filtered'],
    ['/{COIN}/api/delegation_revocations', 'getStakeKeyRevocations', null, 'Staking', 'Signing-key revocations (DELEGATE v2/v3)'],
    ['/{COIN}/api/collects/{QUERY}/{TYPE}', 'getCollects', ['block', 'address', 'source'], 'Staking', 'Validator reward claims, filtered'],
    ['/{COIN}/api/collects', 'getCollects', null, 'Staking', 'Validator reward claims (COLLECT)'],
    ['/{COIN}/api/capability_slash_events/{QUERY}/{TYPE}', 'getCapabilitySlashEvents', ['block', 'capability', 'pubkey', 'address'], 'Staking', 'Capability equivocation slashes, filtered'],
    ['/{COIN}/api/capability_slash_events', 'getCapabilitySlashEvents', null, 'Staking', 'Capability equivocation slashes (SLASH)'],
    ['/{COIN}/api/oracle_prices/{QUERY}/{TYPE}', 'getOraclePrices', ['token', 'address'], 'Prices', 'User token/fiat oracle prices, filtered'],
    ['/{COIN}/api/oracle_prices', 'getOraclePrices', null, 'Prices', 'User token/fiat oracle prices (PRICE v1, hub-mirrored)'],
    // ── Governance ────────────────────────────────────────────────────────
    // Hub-only tables read from the mandatory co-located hub DB (no on-chain action).
    ['/{COIN}/api/validator_capabilities/{QUERY}/{TYPE}', 'getValidatorCapabilities', ['capability', 'pubkey'], 'Governance', 'Per-validator capability qualification flags, filtered'],
    ['/{COIN}/api/validator_capabilities', 'getValidatorCapabilities', null, 'Governance', 'Per-validator per-capability qualification flags (hub-owned)'],
    ['/{COIN}/api/governance_proposals/{QUERY}/{TYPE}', 'getGovernanceProposals', ['status', 'parameter', 'proposal'], 'Governance', 'Federation governance proposals, filtered'],
    ['/{COIN}/api/governance_proposals', 'getGovernanceProposals', null, 'Governance', 'Federation governance parameter proposals (hub-owned)'],
    ['/{COIN}/api/governance_votes/{QUERY}/{TYPE}', 'getGovernanceVotes', ['proposal', 'voter'], 'Governance', 'Per-validator governance votes, filtered'],
    ['/{COIN}/api/governance_votes', 'getGovernanceVotes', null, 'Governance', 'Per-validator governance votes (hub-owned)'],
    // ── Network / operational ─────────────────────────────────────────────
    // Hub-local operational tables read from the mandatory co-located hub DB (no on-chain action, no hub RPC surface).
    ['/{COIN}/api/peers/{QUERY}/{TYPE}', 'getPeers', ['validator'], 'Network', 'P2P peer roster, filtered by validator'],
    ['/{COIN}/api/peers', 'getPeers', null, 'Network', 'P2P peer roster the hub gossips with (hub-owned)'],
    ['/{COIN}/api/consensus_state/{QUERY}/{TYPE}', 'getConsensusState', ['key'], 'Network', 'Hub consensus key/value state, filtered by key'],
    ['/{COIN}/api/consensus_state', 'getConsensusState', null, 'Network', 'Hub consensus key/value state (hub-owned)'],
    ['/{COIN}/api/configs/{QUERY}/{TYPE}', 'getConfigs', ['coin', 'module'], 'Network', 'Hub config-oracle parameters, filtered by coin/module'],
    ['/{COIN}/api/configs', 'getConfigs', null, 'Network', 'Hub config-oracle parameter store (hub-owned)'],
    ['/{COIN}/api/telemetry_pings/{QUERY}/{TYPE}', 'getTelemetryPings', ['event', 'install', 'country'], 'Network', 'Anonymous node telemetry pings, filtered by event/install/country'],
    ['/{COIN}/api/telemetry_pings', 'getTelemetryPings', null, 'Network', 'Anonymous xchain-node telemetry pings (hub-owned)'],
    // VOTE token-weighted governance (polls = v0, ballots = v1, results = frozen v2 tally)
    ['/{COIN}/api/polls/{QUERY}/{TYPE}', 'getPolls', ['block', 'tick', 'status', 'source'], 'Governance', 'VOTE governance polls, filtered by block/tick/status/creator'],
    ['/{COIN}/api/polls', 'getPolls', null, 'Governance', 'VOTE governance polls (token-weighted; poll id = the creating action_index)'],
    ['/{COIN}/api/poll/{QUERY}', 'getPoll', 'poll', 'Governance', 'A single VOTE poll definition + finalization summary'],
    ['/{COIN}/api/poll/{QUERY}/results', 'getPollResults', 'poll', 'Governance', 'Frozen per-option tally for a poll (empty until finalized)'],
    ['/{COIN}/api/votes/{QUERY}/{TYPE}', 'getVotes', ['address', 'poll', 'block'], 'Governance', 'VOTE ballots, filtered by voter/poll/block'],
    ['/{COIN}/api/votes', 'getVotes', null, 'Governance', 'VOTE ballots (v1; one row per voter per poll)'],
    // ── Betting (BET) ─────────────────────────────────────────────────────
    ['/{COIN}/api/bet_feeds/{QUERY}/{TYPE}', 'getBetFeeds', ['block', 'address', 'source', 'token', 'status'], 'Betting', 'BET markets, filtered by block/oracle/wager token/status'],
    ['/{COIN}/api/bet_feeds', 'getBetFeeds', null, 'Betting', 'BET markets (parimutuel; feed id = the creating action_index)'],
    ['/{COIN}/api/bet_feed/{QUERY}', 'getBetFeed', 'bet_feed', 'Betting', 'A single BET market: terms, per-outcome pools, and the full status timeline'],
    ['/{COIN}/api/bets/{QUERY}/{TYPE}', 'getBets', ['block', 'address', 'feed', 'token', 'status'], 'Betting', 'BET wagers, filtered by bettor/market/token/status/block'],
    ['/{COIN}/api/bets', 'getBets', null, 'Betting', 'BET wagers (one row per placed bet)'],
    ['/{COIN}/api/oracle/{QUERY}', 'getOracleStats', 'oracle', 'Betting', 'Oracle track record for an address (v0 reputation; per-address, unbonded)'],
    // ── Cross-chain ───────────────────────────────────────────────────────
    ['/{COIN}/api/cross_chain_matches/{QUERY}/{TYPE}', 'getCrossChainMatches', ['match', 'block', 'status'], 'Cross-chain', 'Cross-chain order matches, filtered'],
    ['/{COIN}/api/cross_chain_matches', 'getCrossChainMatches', null, 'Cross-chain', 'Cross-chain order matches (hub-replicated)'],
    ['/{COIN}/api/cross_chain_settlements/{QUERY}/{TYPE}', 'getCrossChainSettlements', ['match', 'block'], 'Cross-chain', 'Cross-chain settlement legs, filtered'],
    ['/{COIN}/api/cross_chain_settlements', 'getCrossChainSettlements', null, 'Cross-chain', 'Cross-chain settlement legs'],
    ['/{COIN}/api/xcalls/{QUERY}/{TYPE}', 'getXcalls', ['block', 'contract', 'status'], 'Cross-chain', 'XCALL cross-chain call requests, filtered by block/contract/status'],
    ['/{COIN}/api/xcalls', 'getXcalls', null, 'Cross-chain', 'XCALL cross-chain call requests (VM-emitted; read-only)'],
    ['/{COIN}/api/xcall/{QUERY}', 'getXcall', 'call_id', 'Cross-chain', 'Full XCALL lifecycle by call_id (request + target execution + source callback)'],
    // ── Attestations ──────────────────────────────────────────────────────
    ['/{COIN}/api/attestations/{QUERY}/{TYPE}', 'getAttestations', ['block', 'address', 'contract'], 'Attestations', 'ATTEST requests/responses, filtered'],
    ['/{COIN}/api/attestations', 'getAttestations', null, 'Attestations', 'ATTEST v0 requests + v1 responses (incl. LLM attestations)'],
    // ── Anchors ───────────────────────────────────────────────────────────
    ['/{COIN}/api/anchors/{QUERY}/{TYPE}', 'getAnchors', ['block', 'chain', 'network', 'status'], 'Checkpoints', 'ANCHOR state checkpoints, filtered by block/chain/network/status'],
    ['/{COIN}/api/anchors', 'getAnchors', null, 'Checkpoints', 'ANCHOR state checkpoints (cross-chain quorum-signed)'],
    // ── Core ──────────────────────────────────────────────────────────────
    ['/{COIN}/api/status', 'getStatus', null, 'Network', 'Explorer status + chain config'],
    ['/{COIN}/api/actions', 'getActions', null, 'Core', 'Recent actions (all types)'],
    ['/{COIN}/api/action/{QUERY}', 'getAction', 'action_index', 'Core', 'One action with full decoded data (by action index)'],
    ['/{COIN}/api/address/{QUERY}', 'getAddress', 'address', 'Core', 'Address summary'],
    ['/{COIN}/api/balances/{QUERY}', 'getBalances', 'address', 'Core', 'Token balances for an address'],
    ['/{COIN}/api/block/{QUERY}', 'getBlock', 'block', 'Core', 'Block summary (by height or hash)'],
    ['/{COIN}/api/credits/{QUERY}/{TYPE}', 'getCredits', ['block', 'address'], 'Core', 'Ledger credits'],
    ['/{COIN}/api/debits/{QUERY}/{TYPE}', 'getDebits', ['block', 'address'], 'Core', 'Ledger debits'],
    ['/{COIN}/api/escrows/{QUERY}/{TYPE}', 'getEscrows', ['block', 'address'], 'Core', 'Escrowed balances (orders/swaps/dispensers)'],
    ['/{COIN}/api/history/{QUERY}/{TYPE}', 'getHistory', ['block', 'address', 'token', 'recent'], 'Core', 'Combined action history'],
    ['/{COIN}/api/holders/{QUERY}', 'getHolders', 'token', 'Tokens', 'Holders of a token'],
    ['/{COIN}/api/mempool/{QUERY}/{TYPE}', 'getMempool', ['address', 'token'], 'Core', 'Unconfirmed (mempool) actions from the decoder. PRE-VALIDATION: the indexer may still reject them; rows carry the raw decoded action string in `data` for clients to parse'],
    ['/{COIN}/api/network', 'getNetwork', null, 'Network', 'Network statistics'],
    ['/{COIN}/api/pubkey/{QUERY}', 'getPublicKey', 'address', 'Core', 'Known public key for an address'],
    ['/{COIN}/api/project/{QUERY}', 'getProject', 'token', 'Tokens', 'Project registry roster (official tokens of a project tick)'],
    ['/{COIN}/api/token/{QUERY}', 'getToken', 'token', 'Tokens', 'Token detail (supply, info, NFT/registry surfaces)'],
    ['/{COIN}/api/tokens/{QUERY}/{TYPE}', 'getTokens', ['block', 'address', 'token', 'subtoken'], 'Tokens', 'Token search'],
    ['/{COIN}/api/transaction/{QUERY}/{TYPE}', 'getTransaction', ['tx_hash', 'tx_index'], 'Core', 'Transaction lookup'],
    // ── Markets ───────────────────────────────────────────────────────────
    ['/{COIN}/api/markets', 'getMarkets', null, 'Markets', 'All trading pairs'],
    ['/{COIN}/api/markets/{TICK1}', 'getMarkets', null, 'Markets', 'Trading pairs for one tick'],
    ['/{COIN}/api/market/{TICK1}/{TICK2}', 'getMarket', null, 'Markets', 'Market summary for a pair'],
    ['/{COIN}/api/market/{TICK1}/{TICK2}/history', 'getMarketHistory', null, 'Markets', 'Trade history for a pair'],
    ['/{COIN}/api/market/{TICK1}/{TICK2}/history/{ADDRESS}', 'getMarketHistory', null, 'Markets', 'Trade history for a pair, one address'],
    ['/{COIN}/api/market/{TICK1}/{TICK2}/orders', 'getMarketOrders', null, 'Markets', 'Open orders for a pair'],
    ['/{COIN}/api/market/{TICK1}/{TICK2}/orders/{ADDRESS}', 'getMarketOrders', null, 'Markets', 'Open orders for a pair, one address'],
    ['/{COIN}/api/market/{TICK1}/{TICK2}/orderbook', 'getOrderbook', null, 'Markets', 'Aggregated order book for a pair'],
];

// Pre-wildcard routes registered directly on the Express app in setupUrls().
const SPECIAL = [
    // The 200 is declared by hand because this route returns BYTES, not JSON, and the
    // generic default would publish a paginated ListResponse over an octet stream (#3900).
    ['/{COIN}/api/file/{ACTION_INDEX}/raw', 'Files',
        'Raw FILE bytes (gated: ciphertext as octet-stream; non-gated: inline for safe media types)',
        null,
        { response200: {
            description: 'Raw file bytes. A gated FILE is ALWAYS application/octet-stream '
                + '(12-byte nonce || AES-256-GCM ciphertext || 16-byte tag; X-XChain-Stored-Form: encrypted). '
                + 'A non-gated FILE is served under its declared media type when that type is render-safe '
                + '(image/*, audio/*, video/* except image/svg+xml, application/pdf, application/json) '
                + 'and as an application/octet-stream attachment otherwise.',
            content: {
                'application/octet-stream': { schema: { type: 'string', format: 'binary' } },
                '*/*':                      { schema: { type: 'string', format: 'binary' } },
            } } }],
    ['/{COIN}/api/feequote', 'Fees', 'Native-coin protocol fee pre-flight quote (proxied from the indexer)'],
    ['/{COIN}/api/feeschedule', 'Fees', 'Fee schedule + oracle prices (proxied from the indexer)'],
    // . This entry existed in the generated openapi.json but not here,
    // so it was hand-written into the output and the next regeneration would
    // have silently dropped it. Kept in the generator instead.
    ['/{COIN}/api/oraclefeequote', 'Fees', 'Oracle usage fee quote for a Mode B dispenser (proxied from the indexer)',
        'A dispenser naming an ORACLE_ADDRESS pays the oracle operator up front as a native-coin output, sized from the escrow the action adds. Returns requiredFeeNative / requiredFeeSats / belowDust. Backed by the same computation the indexer validates with, so an output sized from this quote is accepted.'],
    // . The verdict is decoupled from native-fee support: `supported` means
    // the handler actually ran, `valid` is the on-chain validity answer, and a
    // null `valid` means no verdict was produced (denied / feeExempt / busy /
    // guardInert), never "invalid".
    ['/{COIN}/api/preflight', 'Core',
        'Validity-first pre-flight of an action against the current tip (would it be accepted); proxied from the indexer',
        'Dry-runs the action against the current tip inside a forced rollback and returns its validity verdict. '
        + 'Nothing is persisted or broadcast. `valid: null` means no verdict was produced, and the sibling flag says why: '
        + '`denied` (VM actions such as DEPLOY/EXECUTE/XEXEC/BATCH are not offered on this public surface), '
        + '`feeExempt` (a settlement/lifecycle action with nothing to dry-run), '
        + '`busy` (the dry-run admission window is full; retryable), or '
        + '`guardInert` (the action is a controller-bound token whose guard is never entered here, so re-check on an authenticated tier). '
        + 'The protocol fee is settled the way `feeMode` says the real transaction will, so a payer who cannot cover an '
        + 'XCHAIN-settled fee is told `invalid` here rather than after paying a miner fee; `feeTokenBalance` and '
        + '`feeAffordable` report that balance beside `xchainFee`. '
        + 'Verdicts are memoized per block height and settlement mode, so a repeat at the same tip returns `cached: true`.',
        {
            query: [
                { name: 'action', required: true, schema: { type: 'string', pattern: '^[A-Z0-9_]{1,32}$' },
                    example: 'SEND', description: 'Action name (aliases are resolved)' },
                { name: 'params', required: false, schema: { type: 'string', maxLength: 8192 },
                    example: '0|JDOG|1|bc1qexampleaddress', description: 'Pipe-delimited action parameters, exactly as encoded on the wire' },
                { name: 'source', required: false, schema: { type: 'string', maxLength: 4096 },
                    description: 'Source address the action would be sent from' },
                // : the verdict differs by settlement mode, so the caller states which
                // one it is composing rather than the endpoint assuming the native one.
                { name: 'feeMode', required: false, schema: { type: 'string', enum: ['xchain', 'native'] },
                    description: 'How the transaction being composed will settle the protocol fee. The verdict differs: `xchain` debits the payer XCHAIN balance, `native` pays a coin output to the fee destination. Omit it to get the chain default (native on LTC/DOGE, the XCHAIN debit on BTC).' },
            ],
            schema: { $ref: '#/components/schemas/PreflightResponse' },
            responses: {
                501: { description: 'Pre-flight unavailable: no indexer API is configured for this coin/network',
                    content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
                502: { description: 'The upstream indexer could not be reached or errored',
                    content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
                503: null,   // the route resolves the coin itself and 404s; it never emits CoinUnavailable
            },
        }],
    ['/{COIN}/api/checkpoints', 'Checkpoints', 'Latest quorum-signed state checkpoints for this chain',
        null,
        { schema: { $ref: '#/components/schemas/CheckpointListResponse' },
          // `limit` is the one query param the handler reads; page/sortorder are inherited
          // pagination the route has never honored (#3901).
          query: [{ name: 'limit', required: false,
                    schema: { type: 'integer', minimum: 1, maximum: 100, default: 10 },
                    description: 'Rows to return; clamped server-side to 1..100' }] }],
    ['/{COIN}/api/checkpoint/{BLOCK_INDEX}/verify', 'Checkpoints', 'Verify a checkpoint: 2f+1 signatures, canonical string, validator set'],
    // from/to are `required` because the handler 400s (INVALID_RANGE) without them, so a
    // client generated off the inherited page/limit/sortorder set could not call it (#3902).
    ['/{COIN}/api/checkpoints/range', 'Checkpoints', 'Quorum-signed checkpoints in a [from,to] block range (SPV forward-following)',
        null,
        { schema: { $ref: '#/components/schemas/CheckpointListResponse' },
          query: [
            { name: 'from', required: true, schema: { type: 'integer', minimum: 0 },
              description: 'First block height of the range, inclusive' },
            { name: 'to',   required: true, schema: { type: 'integer', minimum: 0 },
              description: 'Last block height of the range, inclusive; must be >= from. The span is capped server-side at 500 rows' },
          ] }],
    ['/{COIN}/api/hub-mirror/status', 'Checkpoints', 'Self-synced hub-mirror status: bootstrap state and watermark lag ({enabled:false} in externally-maintained mode)'],
    ['/{COIN}/api/proof/balance/{ADDRESS}/{TICK}', 'Proofs', 'SPV balance inclusion proof for an address/tick against the committed balances_root (height optional)'],
    // Present in the generated openapi.json but never in this table, so it survived only
    // as a hand-edit the next regeneration would drop: the  hazard, second instance.
    ['/{COIN}/api/proof/locked-balance/{ADDRESS}/{TICK}', 'Proofs', 'SPV locked-balance (XCHAIN_ESC) inclusion proof for an address/tick against the committed balances_root; 409 below the escrow leaf armed height (height optional)'],
    ['/{COIN}/api/proof/action/{ACTION_INDEX}', 'Proofs', 'SPV inclusion proof for an action against the committed state tree'],
    ['/{COIN}/api/proof/validator-set', 'Proofs', 'SPV proof of the BTC validator set at a snapshot height (stakes_root; BTC-only)'],
    ['/{COIN}/api/proof/contract-state/{CONTRACT_INDEX}/{KEY}', 'Proofs', 'SPV contract-state proof (not implemented in state_root_version 1; committed EMPTY per spec D1, returns 501)'],
];

const QUERY_DESC = {
    block: 'block height', address: 'an XChain address', source: 'source address',
    destination: 'destination address', token: 'a token tick', contract: 'contract action index',
    oracle: "a dispenser's ORACLE_ADDRESS (PRICE v1 publisher)",
    execution: 'execution action index', action_index: 'action index', match: 'cross-chain match id',
    pair: 'COIN/FIAT pair (e.g. BTC/USD)', round: 'oracle round id', status: 'lifecycle status',
    chain: 'target chain (e.g. BTC, LTC, DOGE)', network: 'target network (mainnet, testnet, regtest)',
    subtoken: 'parent tick (returns its sub-tokens)', recent: 'recent rows',
    tx_hash: 'transaction hash', tx_index: 'transaction index',
    call_id: 'cross-chain call id (64-hex)',
    poll: 'poll id (the creating action_index)', tick: 'a token tick',
    validator: 'validator id (peer)', key: 'consensus state key name',
    coin: 'coin symbol (e.g. BTC, LTC, DOGE)', module: 'service module name',
    event: 'telemetry event (install, update, start, heartbeat)',
    install: 'anonymous install UUID', country: 'ISO-3166 country code',
};

function opId(p) {
    return p.replace('/{COIN}/api/', '').replace(/[{}]/g, '').replace(/[\/]+/g, '_').toLowerCase() || 'root';
}
function pathParams(p, types) {
    const params = [{ $ref: '#/components/parameters/coin' }];
    if (p.includes('{QUERY}')) {
        const kinds = Array.isArray(types) ? types : [types];
        params.push({
            name: 'QUERY', in: 'path', required: true, schema: { type: 'string' },
            description: 'The value to look up (interpreted per {TYPE}): ' +
                kinds.filter(Boolean).map((t) => `${t} = ${QUERY_DESC[t] || t}`).join('; '),
        });
    }
    if (p.includes('{TYPE}'))
        params.push({
            name: 'TYPE', in: 'path', required: true,
            schema: { type: 'string', enum: types },
            description: 'How to interpret {QUERY}',
        });
    for (const extra of ['TICK1', 'TICK2', 'TICK', 'ADDRESS', 'ACTION_INDEX', 'BLOCK_INDEX', 'CONTRACT_INDEX', 'KEY'])
        if (p.includes(`{${extra}}`))
            params.push({ name: extra, in: 'path', required: true, schema: { type: 'string' } });
    return params;
}
const LIST_METHODS_SINGLE = new Set(['getAction', 'getAddress', 'getBlock', 'getToken', 'getProject',
    'getContract', 'getContractState', 'getContractBalance', 'getExecution', 'getPublicKey',
    'getStatus', 'getNetwork', 'getMarket', 'getOrderbook', 'getTransaction', 'getSearch', 'getXcall', 'getPoll',
    // BET single-object reads: getBetFeed resolves one market (terms + pools +
    // timeline) and getOracleStats one aggregate record, so neither paginates.
    'getBetFeed', 'getOracleStats']);

// `opts` (SPECIAL entries only) describes a route the table conventions cannot:
// {query: [...]} its own query parameters instead of page/limit/sortorder,
// {schema} a 200 body that is neither ListResponse nor ObjectResponse,
// {responses} extra status codes (a null value DELETES a default one, for
// routes that cannot emit it), and {response200} an entire 200 entry, for a
// body that is not JSON at all (binary routes; #3900). Without this every
// SPECIAL route inherited the paginated-list contract, which is wrong for the
// indexer proxies: they take an `action`, return one object, and never 503.
function operation([p, method, types, tag, summary], opts) {
    const o = opts || {};
    const isList = !o.query && !o.schema && !o.response200 && !LIST_METHODS_SINGLE.has(method);
    const params = pathParams(p, types);
    if (isList) params.push(
        { $ref: '#/components/parameters/page' },
        { $ref: '#/components/parameters/limit' },
        { $ref: '#/components/parameters/sortorder' });
    for (const q of o.query || []) params.push(Object.assign({ in: 'query' }, q));
    const responses = {
        200: o.response200 || {
            description: 'OK',
            content: {
                'application/json': {
                    schema: o.schema
                        || { $ref: isList ? '#/components/schemas/ListResponse' : '#/components/schemas/ObjectResponse' },
                },
            },
        },
        400: { $ref: '#/components/responses/BadRequest' },
        404: { $ref: '#/components/responses/NotFound' },
        503: { $ref: '#/components/responses/CoinUnavailable' },
    };
    for (const [code, body] of Object.entries(o.responses || {})) {
        if (body === null) delete responses[code];
        else responses[code] = body;
    }
    return {
        get: {
            operationId: opId(p), tags: [tag], summary,
            parameters: params,
            responses,
        },
    };
}

const paths = {};
for (const r of ROUTES) paths[r[0]] = operation(r);
for (const [p, tag, summary, description, opts] of SPECIAL) {
    paths[p] = operation([p, 'special_' + opId(p), null, tag, summary], opts);
    // Optional 4th element: prose that does not fit a one-line summary. Added
    // for oraclefeequote, whose entry had been hand-written into the generated
    // file WITH a description the generator could not express, so regenerating
    // silently dropped it.
    if (description) paths[p].get.description = description;
    paths[p]['x-registered'] = 'express';   // direct app.get(), not the urls.api table
}

const spec = {
    openapi: '3.1.0',
    info: {
        title: 'XChain Explorer API',
        version: '1.0.0',
        description: 'Read-only REST API for the XChain Platform: tokens, balances, actions, '
            + 'markets, smart contracts, staking, attestations, and state checkpoints on '
            + 'Bitcoin, Litecoin, and Dogecoin.\n\n'
            + 'Conventions: `coin` is the host chain, `tick` is a token symbol (there is no '
            + '"asset" field). Amounts are arbitrary-precision decimal strings, and so are chain '
            + 'indices (`block_index`, `action_index`, `checkpoint_seq`, `snapshot_block`) on both '
            + 'the REST and WebSocket surfaces: they compare byte-for-byte across endpoints and stay '
            + 'exact above 2^53. List responses '
            + 'are `{total, data: [...]}` with `page`/`limit`/`sortorder` query parameters '
            + '(limit max 100; balances/holders max 500). Errors are '
            + '`{error: "message", code: "STABLE_CODE"}`. See the error-code registry at '
            + 'https://docs.xchain.io/protocol/Error_Codes.md. A WebSocket API lives at '
            + '/{COIN}/api/websocket. See https://docs.xchain.io/components/explorer/WEBSOCKET.md.\n\n'
            + 'LLM-friendly docs: https://docs.xchain.io/llms.txt',
        license: { name: 'AGPL-3.0-or-later', url: 'https://docs.xchain.io/legal/LICENSING.md' },
    },
    servers: [{ url: 'https://explorer.xchain.io' }],
    tags: [
        { name: 'Core' }, { name: 'Tokens' }, { name: 'Action history' }, { name: 'Markets' },
        { name: 'Dispensers' }, { name: 'Contracts' }, { name: 'Staking' }, { name: 'Prices' },
        { name: 'Attestations' }, { name: 'Cross-chain' }, { name: 'Files' }, { name: 'Fees' },
        { name: 'Checkpoints' }, { name: 'Governance' }, { name: 'Network' },
    ],
    paths,
    components: {
        parameters: {
            coin: {
                name: 'COIN', in: 'path', required: true,
                schema: { type: 'string', enum: COINS },
                description: 'Chain + network: BTC/LTC/DOGE mainnet; T prefix = testnet, R prefix = regtest',
            },
            page: { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1, default: 1 }, description: 'Page number' },
            limit: { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 500, default: 10 }, description: 'Rows per page (max 100; balances/holders max 500)' },
            sortorder: { name: 'sortorder', in: 'query', schema: { type: 'string', enum: ['asc', 'desc'] }, description: 'Sort order' },
        },
        schemas: {
            ListResponse: {
                type: 'object',
                properties: {
                    total: { type: 'integer', description: 'Total matching rows' },
                    data: { type: 'array', items: { type: 'object' }, description: 'Result rows (fields vary per endpoint; amounts are decimal strings)' },
                },
                required: ['total', 'data'],
            },
            ObjectResponse: { type: 'object', description: 'Single result object (fields vary per endpoint; amounts are decimal strings)' },
            // The checkpoint routes answer {checkpoints, count}, never the generic
            // {total, data} list envelope (#3901). /checkpoints additionally spreads the
            // mirror-gate annotation, so those two fields are optional, not required.
            CheckpointListResponse: {
                type: 'object',
                properties: {
                    checkpoints: { type: 'array', items: { type: 'object' },
                        description: 'Quorum-signed state checkpoints (fields vary per row; chain indices are decimal strings)' },
                    count: { type: 'integer', description: 'Number of checkpoints returned' },
                    mirror_bootstrapped: { type: 'boolean', description: 'Self-synced hub mirror has completed its initial bootstrap (present only on /checkpoints)' },
                    mirror_lag_seconds: { type: ['integer', 'null'], description: 'Age of the mirror watermark (present only on /checkpoints)' },
                },
                required: ['checkpoints', 'count'],
            },
            // . Mirrors xchain-indexer Actions.computePreflight(); `valid` is
            // nullable because "no verdict" is a distinct answer from "invalid".
            PreflightResponse: {
                type: 'object',
                properties: {
                    action: { type: 'string', description: 'The action as classified, after alias resolution' },
                    coin: { type: 'string', description: 'Host chain the verdict was computed on' },
                    supported: { type: 'boolean', description: 'Whether the action handler actually ran (independent of native-fee support)' },
                    valid: { type: ['boolean', 'null'], description: 'Would the action be accepted at the current tip; null when no verdict was produced' },
                    status: { type: 'string', description: 'Verdict status from the dry-run ("valid", or the rejecting status)' },
                    error: { type: ['string', 'null'], description: 'Why the action would be rejected; null when valid' },
                    guardInert: { type: 'boolean', description: 'The controller guard was not entered, so the verdict is inconclusive' },
                    denied: { type: 'boolean', description: 'Action is not offered on this public surface (VM actions)' },
                    feeExempt: { type: 'boolean', description: 'Settlement/lifecycle action with no dry-runnable verdict' },
                    busy: { type: 'boolean', description: 'Dry-run admission window full; retry shortly' },
                    retryable: { type: 'boolean', description: 'Set alongside busy' },
                    cached: { type: 'boolean', description: 'Served from the block-height-keyed verdict memo' },
                    note: { type: 'string', description: 'Explanatory text accompanying a no-verdict response' },
                    // . Echoed from the same dry-run that produced the verdict, so a
                    // confirm screen can disclose the protocol fee without a second call to
                    // /feequote. XCHAIN-denominated (the fee row is, in every payment mode);
                    // sizing a native-coin output is still /feequote's job.
                    xchainFee: { type: ['string', 'null'], description: 'Protocol fee the action would owe, XCHAIN-denominated decimal string (8dp); null when the run staged no fee record, absent on no-verdict responses' },
                    // . Which way the fee was settled in the dry-run, and what the payer
                    // holds to settle it with: without these a caller cannot tell an XCHAIN-mode
                    // refusal apart from a structural one, or see it coming at all.
                    feeMode: { type: 'string', enum: ['xchain', 'native'], description: 'Fee settlement mode the verdict was computed under' },
                    feeTick: { type: 'string', description: 'Ticker the protocol fee is denominated in (the gas token)' },
                    feeTokenBalance: { type: ['string', 'null'], description: 'Payer balance of feeTick at the quoted height, decimal string (8dp); null when it could not be read' },
                    feeAffordable: { type: ['boolean', 'null'], description: 'Whether feeTokenBalance covers xchainFee; null in native mode (the fee is not paid from that balance) or when either input is unknown' },
                    // Deliberately typed as they are actually emitted. This proxy passes the
                    // indexer's dry-run values straight through as JSON numbers, so it is the
                    // one endpoint that departs from the decimal-string convention for chain
                    // indices stated above. Documented rather than quietly re-typed, because
                    // clients already parse the shipped shape.
                    blockIndex: { type: 'integer', description: 'Tip height the verdict was computed against (a JSON number here, not a decimal string)' },
                    blockTime: { type: 'integer', description: 'Unix timestamp of that block, used for the dry-run' },
                },
                required: ['action', 'supported'],
            },
            Error: {
                type: 'object',
                properties: {
                    error: { type: 'string', description: 'Human-readable message' },
                    code: { type: 'string', description: 'Stable machine-readable code (see https://docs.xchain.io/protocol/Error_Codes.md)' },
                },
                required: ['error'],
            },
        },
        responses: {
            BadRequest: { description: 'Bad request', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
            NotFound: { description: 'Not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
            CoinUnavailable: { description: 'Coin not configured on this explorer', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
    },
};

const out = path.join(__dirname, 'openapi.json');
fs.writeFileSync(out, JSON.stringify(spec, null, 2) + '\n');
console.log(`wrote ${out}: ${Object.keys(paths).length} paths (${ROUTES.length} table routes + ${SPECIAL.length} special)`);
