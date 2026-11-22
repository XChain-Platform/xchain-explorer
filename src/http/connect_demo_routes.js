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
 * XChain Explorer - callback receiver for the public connect demo
 *
 ********************************************************************/

'use strict';

const ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;

function createConnectDemoStore({
    now = Date.now,
    ttlMs = 10 * 60 * 1000,
    maxEntries = 2000,
    maxEntriesPerIp = 20,
    maxCallbacks = 3
} = {}){
    const entries = new Map();

    function prune(){
        const current = now();
        for(const [id, entry] of entries)
            if(entry.expiresAt <= current) entries.delete(id);
    }

    function expect(id, ip){
        prune();
        if(entries.has(id)) return { status: 'exists' };
        if(entries.size >= maxEntries) return { status: 'full' };

        let ipEntries = 0;
        for(const entry of entries.values())
            if(entry.ip === ip) ipEntries++;
        if(ipEntries >= maxEntriesPerIp) return { status: 'ip-full' };

        const expiresAt = now() + ttlMs;
        entries.set(id, { ip, expiresAt, callbacks: [] });
        return { status: 'created', expiresAt };
    }

    function callback(id, body){
        prune();
        const entry = entries.get(id);
        if(!entry) return null;
        entry.callbacks.push(body);
        if(entry.callbacks.length > maxCallbacks)
            entry.callbacks.splice(0, entry.callbacks.length - maxCallbacks);
        return { expiresAt: entry.expiresAt, count: entry.callbacks.length };
    }

    function result(id){
        prune();
        const entry = entries.get(id);
        if(!entry) return null;
        return {
            expiresAt: entry.expiresAt,
            callbacks: entry.callbacks.slice()
        };
    }

    return { expect, callback, result };
}

function createConnectDemoHandlers(store){
    function validId(req, res){
        const id = String((req.params && req.params.id) || '');
        if(ID_PATTERN.test(id)) return id;
        res.status(400).json({ error: 'Invalid request id', code: 'INVALID_REQUEST_ID' });
        return null;
    }

    return {
        expect(req, res){
            const id = validId(req, res);
            if(id === null) return;
            const outcome = store.expect(id, req.ip);
            if(outcome.status === 'exists')
                return res.status(409).json({ error: 'Request id already expected', code: 'REQUEST_ID_REUSED' });
            if(outcome.status === 'full' || outcome.status === 'ip-full')
                return res.status(503).json({ error: 'Callback receiver is full', code: 'RECEIVER_FULL' });
            return res.status(201).json({ expected: true, exp: outcome.expiresAt });
        },

        callback(req, res){
            const id = validId(req, res);
            if(id === null) return;
            const outcome = store.callback(id, req.body);
            if(!outcome)
                return res.status(404).json({ error: 'Request id not found', code: 'REQUEST_ID_NOT_FOUND' });
            return res.status(202).json({ received: true });
        },

        result(req, res){
            const id = validId(req, res);
            if(id === null) return;
            const outcome = store.result(id);
            if(!outcome)
                return res.status(404).json({ error: 'Request id not found', code: 'REQUEST_ID_NOT_FOUND' });
            if(outcome.callbacks.length === 0)
                return res.status(202).json({ received: false });
            return res.json({ received: true, callbacks: outcome.callbacks, exp: outcome.expiresAt });
        }
    };
}

function mountConnectDemoRoutes(app, options = {}){
    const store = options.store || createConnectDemoStore(options);
    const handlers = createConnectDemoHandlers(store);
    app.post('/connect-demo/expect/:id', (req, res) => handlers.expect(req, res));
    app.post('/connect-demo/callback/:id', (req, res) => handlers.callback(req, res));
    app.get('/connect-demo/result/:id', (req, res) => handlers.result(req, res));
    return store;
}

module.exports = { createConnectDemoStore, createConnectDemoHandlers, mountConnectDemoRoutes, ID_PATTERN };
