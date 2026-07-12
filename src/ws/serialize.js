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
 * XChain Explorer - WebSocket-safe JSON serializer
 *
 * mariadb returns BIGINT columns (action_index, block_index, block_time, ...)
 * as JS BigInt, which JSON.stringify throws on ("Do not know how to serialize
 * a BigInt"). Every socket send is wrapped in a try/catch that swallows the
 * throw, so a message carrying a raw DB row is silently dropped at the socket
 * boundary. Coerce BigInt to its DECIMAL STRING form so events reach
 * subscribers.
 *
 * Wire-type contract: BigInt fields serialize as decimal strings on BOTH the
 * WebSocket and the REST API. The REST serializer (utility.jsonStringify) has
 * always emitted these as strings; this path historically emitted numbers,
 * which (a) silently broke strict-equality correlation for consumers
 * reconciling a REST backfill against live WS frames (the CATCH_UP_TOO_OLD
 * "backfill via REST" flow) and (b) lost precision for values above
 * Number.MAX_SAFE_INTEGER (2^53). Emitting strings matches REST and is
 * lossless. A cross-serializer conformance test guards against future drift.
 *
 * Shared by Broadcaster and WebSocketServer so the two send paths cannot drift
 * out of sync again (the WebSocketServer._send path had never received the fix
 * Broadcaster carried).
 *
 ********************************************************************/

'use strict';

function safeStringify(msg) {
    return JSON.stringify(msg, (key, value) => (typeof value === 'bigint' ? value.toString() : value));
}

module.exports = { safeStringify };
