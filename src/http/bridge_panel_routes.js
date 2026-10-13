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
 * XChain Explorer - token-page bridge routes
 *
 * Mounts the pre-wildcard JSON reads used by token.html. The invariant
 * comes from the hub; transfers and applied policy come from the routed
 * coin's co-located hub mirror plus its local indexer state.
 *
 ********************************************************************/

'use strict';

const coins = require('../coins');
const { getLogger } = require('../observability');
const log = getLogger();

function createBridgePanelHandlers(getExplorer, hubConnector){
    const error = (res, status, message, code) =>
        res.status(status).json({ error: message, code });

    const nativeTickFor = (tick, chain) => {
        const dot = tick.indexOf('.');
        const root = dot > 0 ? tick.slice(0, dot).toUpperCase() : '';
        return coins.ALLOWED_COINS.includes(root) && root !== String(chain || '').toUpperCase()
            ? tick.slice(dot + 1) : tick;
    };

    const tickParam = (req, res) => {
        const tick = String((req.params && req.params.tick) || '').trim();
        if(!tick || tick.length > 250 || /[\x00-\x1f\x7f]/.test(tick)){
            error(res, 400, 'Invalid token tick.', 'INVALID_TICK');
            return null;
        }
        return tick;
    };

    return {
        invariant: bridgeInvariantHandler(hubConnector, tickParam, error, nativeTickFor),
        transfers: bridgeTransfersHandler(getExplorer, tickParam, error, nativeTickFor),
        appliedPolicy: appliedPolicyHandler(getExplorer, tickParam, error, nativeTickFor)
    };
}

function bridgeInvariantHandler(hubConnector, tickParam, error, nativeTickFor){
    return async function invariant(req, res){
        const tick = tickParam(req, res);
        if(tick === null) return;
        if(!hubConnector)
            return error(res, 503, 'Bridge invariant is unavailable.', 'BRIDGE_INVARIANT_UNAVAILABLE');
        const routeCoin = String((req.params && req.params.coin) || '').toUpperCase();
        const chain = coins.ALLOWED_COINS.find(coin =>
            routeCoin === coin || routeCoin === 'T' + coin || routeCoin === 'R' + coin);
        if(!chain)
            return error(res, 404, 'Unknown coin.', 'UNKNOWN_COIN');
        const nativeTick = nativeTickFor(tick, chain);
        try {
            const result = await hubConnector.call({
                jsonrpc: '2.0', method: 'getbridgeinvariant', params: { tick: nativeTick }, id: 1
            }, { attempts: 1 });
            if(result === null || result === undefined)
                return error(res, 503, 'Bridge invariant is unavailable.', 'BRIDGE_INVARIANT_UNAVAILABLE');
            // Rename the hub's native key to the rooted spelling the page displays.
            if(nativeTick !== tick && result && typeof result === 'object' &&
               Object.prototype.hasOwnProperty.call(result, nativeTick))
                return res.json({ [tick]: result[nativeTick] });
            return res.json(result);
        } catch(err){
            log.warn('BRIDGE_INVARIANT_READ_FAILED', { err: err && err.message ? err.message : err });
            return error(res, 503, 'Bridge invariant is unavailable.', 'BRIDGE_INVARIANT_UNAVAILABLE');
        }
    };
}

function bridgeTransfersHandler(getExplorer, tickParam, error, nativeTickFor){
    return async function transfers(req, res){
        const tick = tickParam(req, res);
        if(tick === null) return;
        const coin = String((req.params && req.params.coin) || '').toUpperCase();
        const explorer = getExplorer();
        const db = explorer && explorer.db;
        const source = db && db.checkpointDb && db.checkpointDb[coin];
        if(!db || typeof db.getBridgeTransfers !== 'function' || !source ||
           !/^[A-Za-z0-9_$]+$/.test(String(source.name || '')))
            return error(res, 503, 'Bridge transfers are unavailable.', 'BRIDGE_TRANSFERS_UNAVAILABLE');

        // Locks store the native tick while burns store ORIGIN.TICK. Read both
        // spellings so either chain's token page shows both directions. Native
        // subassets retain their dot because only a known foreign root is removed.
        const nativeTick = nativeTickFor(tick, source.chain);
        const copyTick = nativeTick === tick ? String(source.chain) + '.' + nativeTick : tick;

        try {
            const rows = await db.getBridgeTransfers({ coin, schema: source.name, network: source.network,
                tick: nativeTick, copyTick, chain: source.chain, limit: 100 });
            return res.json(Array.isArray(rows) ? rows : []);
        } catch(err){
            log.warn('BRIDGE_TRANSFERS_READ_FAILED', { coin, err: err && err.message ? err.message : err });
            return error(res, 503, 'Bridge transfers are unavailable.', 'BRIDGE_TRANSFERS_UNAVAILABLE');
        }
    };
}

function appliedPolicyHandler(getExplorer, tickParam, error, nativeTickFor){
    return async function appliedPolicy(req, res){
        const tick = tickParam(req, res);
        if(tick === null) return;
        const coin = String((req.params && req.params.coin) || '').toUpperCase();
        const explorer = getExplorer();
        const db = explorer && explorer.db;
        const source = db && db.checkpointDb && db.checkpointDb[coin];
        if(!db || typeof db.getAppliedPolicy !== 'function' || !source ||
           !/^[A-Za-z0-9_$]+$/.test(String(source.name || '')))
            return error(res, 503, 'Applied bridge policy is unavailable.', 'APPLIED_POLICY_UNAVAILABLE');

        const dot = tick.indexOf('.');
        const origin = dot > 0 ? tick.slice(0, dot).toUpperCase() : '';
        if(!coins.ALLOWED_COINS.includes(origin) || origin === String(source.chain || '').toUpperCase())
            return res.json(null);

        try {
            const applied = await db.getAppliedPolicy({
                coin, schema: source.name, network: source.network, origin,
                tick: nativeTickFor(tick, source.chain), copyTick: tick
            });
            return res.json(applied || null);
        } catch(err){
            log.warn('APPLIED_POLICY_READ_FAILED', { coin, err: err && err.message ? err.message : err });
            return error(res, 503, 'Applied bridge policy is unavailable.', 'APPLIED_POLICY_UNAVAILABLE');
        }
    };
}

function mountBridgePanelRoutes(app, getExplorer, hubConnector){
    const handlers = createBridgePanelHandlers(getExplorer, hubConnector);
    app.get('/:coin/api/bridge-invariant/:tick', (req, res) => handlers.invariant(req, res));
    app.get('/:coin/api/bridge-transfers/:tick', (req, res) => handlers.transfers(req, res));
    app.get('/:coin/api/applied-policy/:tick', (req, res) => handlers.appliedPolicy(req, res));
}

module.exports = { createBridgePanelHandlers, mountBridgePanelRoutes };
