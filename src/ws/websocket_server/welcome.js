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
 * XChain Explorer - WebSocket Server: WELCOME and coin resolution
 *
 * The handshake frame every connection receives first, and the coin-prefix
 * map it and the upgrade path resolve chain and network through. WELCOME is
 * assembled from two blocks: the coin's tip indices (with the stale marker)
 * and the server's self-description (limits, channels, types, features).
 *
 * HOW THIS ATTACHES
 *
 * The methods are authored as a class body and exported as that class's
 * prototype, so websocket_server.js can copy them onto WebSocketServer.prototype
 * verbatim. Nothing here is ever instantiated: `this` is the WebSocketServer
 * instance at call time, exactly as it was when these methods sat inline.
 *
 ********************************************************************/

'use strict';

const ChannelManager = require('../channel_manager.js');

// The tip block of WELCOME's data: the server version and clock, the coin's
// latest indices, and the stale marker when those indices are a frozen
// replica's. Key order is the frame's historical order.
function tipBlock(server, latestBlockIndex, latestActionIndex, tipStale) {
    return {
        version:              server.explorer.version || '1.0.0',
        server_time:          Date.now(),
        // Chain indices ride as decimal STRINGS, the v2 wire contract
        // (ws/schema_version.js): every action_index/block_index on a v2
        // frame is a string, and these two arrive from the db getters as
        // Number, which safeStringify leaves as a JSON number. Emitting a
        // number here handed one connection two types for the same field
        // (WELCOME numeric, CATCH_UP_COMPLETE and NEW_ACTION string) and
        // would truncate above 2^53.
        latest_block_index:   String(latestBlockIndex),
        latest_action_index:  String(latestActionIndex),
        // True when the two indices above are a frozen replica's, not the
        // live chain tip; omitted (not false) when fresh so the frame is
        // byte-identical to the historical one on the healthy path.
        ...(tipStale ? { stale: true } : {})
    };
}

// The self-description block of WELCOME's data: the limits a client must stay
// under and the channel, type and feature names it may use.
function schemaBlock(server) {
    return {
        limits: {
            max_subscriptions:      server.channelManager.maxSubscriptions,
            max_message_rate:       server.maxMsgPerSec,
            // Additive: how many messages may arrive at once before the rate applies.
            max_message_burst:      server.messageBurst(),
            max_message_size:       server.maxMessageSize,
            max_connections_per_ip: server.maxPerIp
        },
        // Derived from ChannelManager.VALID_CHANNELS (the single authority
        // that actually validates params.channel) so this self-description
        // cannot silently under-advertise a subscribable channel again.
        channels: [...ChannelManager.VALID_CHANNELS],
        // Derived from ChannelManager.VALID_TYPES (the single authority that
        // actually validates params.types) so this self-description cannot
        // silently under-advertise a filterable type again.
        types: [...ChannelManager.VALID_TYPES],
        // 'statuses' is intentionally NOT advertised: the block-derived
        // actions feed (getActionsSince) never populates a per-action
        // status, so a statuses filter on the actions channel is a silent
        // no-op. Rather than imply a filter we can't honor there (the
        // per-type status joins are deferred), we drop it from the
        // advertised contract so clients cannot rely on it. The filter
        // mechanism still runs for events that do carry a status (e.g.
        // lifecycle/COINPAY frames); it is simply not advertised.
        // 'ticks' is omitted for the same reason: getActionsSince
        // selects no tick/give_tick/get_tick column, so Broadcaster's
        // `if (tick && ...)` check never fires on the actions channel, the
        // only channel ChannelManager.subscribe attaches a ticks filter to.
        features: ['snapshot', 'once', 'fields', 'batch', 'catch_up']
    };
}

// The action_index a client may resume from: the live detector's mark for the coin,
// seeding the coin first if its first poll has not recorded one, or null when this
// server has no detector polling the coin. The DB tip is NOT that position: rows above
// the mark are committed but not yet sent live, so a client that seeded its cursor
// from the tip and dropped before the next poll would resume past rows it never got.
async function liveResumeMark(server, coin) {
    return liveMark(server, coin, 'liveActionMark');
}

// The detector mark named by `method` for the coin, seeding the coin first, or null
// when this server has no detector polling it (each caller then serves the DB tip).
async function liveMark(server, coin, method) {
    const detector = server.broadcaster && server.broadcaster.changeDetector;
    if (!detector || typeof detector[method] !== 'function') return null;
    if (typeof detector.ensureSeeded === 'function') {
        try {
            await detector.ensureSeeded(coin);
        } catch (e) {
            // The fallback serves the DB tip, as a server with no detector does.
        }
    }
    return detector[method](coin);
}

class WebSocketWelcome {

    // The block tip a client may seed its block cursor from: the last block the live
    // feed has sent for the coin, so every NEW_BLOCK that follows is strictly above it.
    // The DB tip is NOT that position: it runs up to one detector poll ahead, so a
    // client told the DB tip would then get that same block as a live NEW_BLOCK. The DB
    // tip stands in only where no detector polls the coin. WELCOME and the blocks
    // SNAPSHOT both read it, so the two never disagree.
    async liveBlockTip(coin) {
        const mark = await liveMark(this, coin, 'liveBlockMark');
        return (mark !== null) ? mark : (await this.explorer.db.getMaxBlockIndex({ coin }) || 0);
    }

    // Send WELCOME message with server info
    async sendWelcome(client) {
        let latestBlockIndex  = 0;
        let latestActionIndex = 0;
        try {
            const db     = this.explorer.db;
            const config = { coin: client.coin };
            latestBlockIndex  = await this.liveBlockTip(client.coin);
            // latest_action_index is the position live delivery resumes from (the
            // detector's mark), so a client that seeds its cursor from it misses
            // nothing; the DB tip stands in only where no detector polls the coin.
            const mark        = await liveResumeMark(this, client.coin);
            latestActionIndex = (mark !== null) ? mark : (await db.getMaxActionIndex(config) || 0);
        } catch (e) {
            // Non-fatal: send WELCOME with zeros
        }

        // WELCOME is the handshake, so it is annotated rather than withheld: a
        // client that never receives it cannot subscribe, unsubscribe or read the
        // limits, which is a worse outage than a marked one. The two indices below
        // are frozen on a stale replica, and unmarked they read as the live chain
        // tip. `stale` is an ADDITIVE optional field, so it needs no
        // WS_SCHEMA_VERSION bump (ws/schema_version.js states the rule), and it
        // carries the same name and meaning as the `stale` map /status publishes
        // over HTTP. Chain DATA is a different question and does fail closed: see
        // handleCatchUp and sendSnapshots.
        const tipStale = await this.isCoinTipStale(client.coin);

        // The marker rides the envelope, where every other frame carries it, so one
        // `msg.stale` check covers the handshake too; `data.stale` stays beside the
        // tip indices it qualifies for consumers that already read it there.
        const welcome = {
            type:      'WELCOME',
            chain:     client.chain,
            network:   client.network,
            timestamp: Date.now(),
            ...(tipStale ? { stale: true } : {}),
            data: {
                ...tipBlock(this, latestBlockIndex, latestActionIndex, tipStale),
                ...schemaBlock(this)
            }
        };

        this.send(client, welcome);
    }

    // Get chain/network info for a coin prefix
    getCoinInfo(coin) {
        return this.resolveCoin(coin) || { chain: coin, network: 'mainnet' };
    }

    // Resolve coin prefix to chain/network (e.g., "TBTC" -> { chain: "BTC", network: "testnet" })
    resolveCoin(coinParam) {
        // Lazy-load valid coins from config
        if (!this.validCoins) {
            this.loadValidCoins();
        }
        return this.validCoins ? this.validCoins[coinParam] : null;
    }

    loadValidCoins() {
        try {
            this.validCoins = {};
            // Build coin map from the known structure: BTC, LTC, DOGE + T/R prefixes
            const chains   = ['BTC', 'LTC', 'DOGE'];
            const prefixes = { '': 'mainnet', 'T': 'testnet', 'R': 'regtest' };

            for (const chain of chains) {
                for (const [prefix, network] of Object.entries(prefixes)) {
                    const coin = prefix + chain;
                    this.validCoins[coin] = { chain, network };
                }
            }
        } catch (e) {
            this.validCoins = null;
        }
    }
}

module.exports = WebSocketWelcome.prototype;
