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
 * XChain Explorer - Channel Manager: channel and type names
 *
 * The name sets a subscribe request is validated against. They live in their
 * own module because the entry and both of its parts read them: the entry hangs
 * them on the class as its static exports, subscribe.js validates against
 * them, and a part cannot require the entry for them while the entry is still
 * loading that part.
 *
 ********************************************************************/

'use strict';

// Valid global channels (no entity params needed)
const GLOBAL_CHANNELS = new Set(['blocks', 'actions', 'mempool', 'network', 'attestation']);

// Valid entity channels (require params)
// bet_feed is action_index-keyed exactly like dispenser: one market per feed id,
// carrying place / latch / resolve / cancel / expire events so a market page and a
// wallet see live pools (§11.1).
// xcall is keyed by the deterministic 64-hex call_id, which is the only stable
// name a cross-chain call has on BOTH chains: its action_index differs per chain
// and the target chain has no request row at all (spec M5.4).
const ENTITY_CHANNELS = new Set(['address', 'token', 'market', 'dispenser', 'bet_feed', 'xcall']);

// Every channel name a subscribe request is allowed to use. A name outside this set
// is refused at subscribe time rather than silently accepted and never delivered.
const ALL_CHANNELS = new Set([...GLOBAL_CHANNELS, ...ENTITY_CHANNELS]);

// Valid action types for the types filter
const VALID_TYPES = new Set([
    // Indexed action types
    'ORDER', 'ORDER_MATCH', 'ORDER_EXPIRE',
    'COINPAY', 'COINPAY_EXPIRE',
    'SWAP', 'SWAP_MATCH', 'SWAP_EXPIRE',
    'DISPENSER', 'DISPENSE', 'DISPENSER_CLOSE', 'DISPENSER_EXPIRE',
    'SEND', 'SWEEP', 'AIRDROP', 'DIVIDEND',
    'ISSUE', 'MINT', 'DESTROY',
    'BROADCAST', 'CALLBACK', 'FILE', 'MESSAGE', 'LIST', 'LINK', 'SLEEP',
    'DEPLOY', 'EXECUTE', 'DEPOSIT', 'WITHDRAW',
    'STAKE', 'UNSTAKE', 'DELEGATE', 'COLLECT', 'ATTEST',
    // BET is one action name over four formats (create/cancel/place/resolve);
    // BET_EXPIRE is the system refund pass's minted action. Both are emitted on the
    // `bet_feed` channel, so both must be filterable: without them a subscriber
    // passing types:['BET'] was rejected outright with INVALID_TYPE, which failed
    // the whole subscribe rather than narrowing it.
    'BET', 'BET_EXPIRE',
    // Federation / cross-chain / oracle action types (real decoded actions
    // dispatched in xchain-indexer actions/index.js; they broadcast on the global
    // `actions` channel, so a client must be able to narrow to them too).
    // NOTE: CONTROLLER is intentionally absent: it is a field on ISSUE/ADDRESS
    // (data['CONTROLLER']), not an `action` type, so it never appears as an
    // actionData.action value and whitelisting it would silently match nothing.
    'PRICE', 'ANCHOR', 'XCALL', 'NODEPROOF', 'ROLLCALL',
    // Lifecycle event types (emitted by ChangeDetector, not indexed directly).
    // Only names the producer actually emits belong here (ws/change_detector.js's
    // LIFECYCLE_MAP, NON_ACTION_LIFECYCLE_TYPES and INLINE_LIFECYCLE_TYPES): the
    // WELCOME envelope advertises this set verbatim, so a phantom name would
    // be accepted by subscribe() yet silently match zero events - same
    // anti-pattern as the CONTROLLER note above.
    'COINPAY_REQUIRED', 'COINPAY_FULFILLED', 'COINPAY_EXPIRED',
    'ORDER_EXPIRED',
    'SWAP_EXPIRED',
    'DISPENSER_CLOSED', 'DISPENSER_EXPIRED',
    // BET_EXPIRED rides LIFECYCLE_MAP; BET_CLOSED is emitted by the ChangeDetector's
    // second cursor over bet_feeds.closed_block, because the deadline latch is a
    // direct status write with no action row behind it.
    'BET_EXPIRED', 'BET_CLOSED',
    // The two XCALL terminal phases, emitted by the ChangeDetector's third cursor
    // over xcalls.resolved_block. A completion is a direct status write with no
    // action row behind it; an expiry does have an XCALL v2 action, but both ride
    // this cursor so a subscriber narrowing to the phase names cannot see one
    // outcome and silently miss the other.
    'XCALL_COMPLETED', 'XCALL_EXPIRED',
    // The two ATTEST phases, enriched inline from the `attests` table because the
    // raw action row carries no version to tell request from response.
    'ATTESTATION_REQUEST', 'ATTESTATION_RESPONSE'
]);

module.exports = { GLOBAL_CHANNELS, ENTITY_CHANNELS, ALL_CHANNELS, VALID_TYPES };
