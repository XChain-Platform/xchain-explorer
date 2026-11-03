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
 * XChain Explorer - per-client fair share of one upstream's egress
 *
 * The indexer and the UTXO tracker both rate-limit per connecting IP, and every
 * call this process makes leaves from one IP, so every explorer client shares one
 * upstream bucket. Left to the upstream, that bucket refuses whoever happens to
 * arrive after it drains, which is usually a client well inside its own explorer
 * limits. Each connector therefore keeps one of these budgets per upstream URL,
 * below the upstream's ceiling, and decides who is shed before the upstream has to.
 *
 * The window is sliding (a log of call times), not fixed: the upstream's fixed
 * window is not aligned with ours, and a fixed window here could put two full
 * budgets inside one of its windows across our boundary.
 *
 ********************************************************************/

'use strict';

const EGRESS_WINDOW_MS     = 60 * 1000;
// Under this share of the budget every client is admitted. Above it, only a client
// still under its fair share (budget over active clients) is, so the clients
// draining the budget are the ones shed and a light client keeps its share.
const EGRESS_SOFT_FRACTION = 0.75;
// Calls made outside any client request (background reads, tip snapshots).
const INTERNAL_CLIENT      = '-';

class EgressBudget {
    constructor(){
        this.times     = [];        // call times, oldest first
        this.clients   = [];        // client key per call, parallel to times
        this.head      = 0;         // first live entry
        this.perClient = new Map(); // client key -> calls in the window
    }

    prune(now){
        while(this.head < this.times.length && this.times[this.head] <= now - EGRESS_WINDOW_MS){
            let k = this.clients[this.head];
            let n = (this.perClient.get(k) || 1) - 1;
            if(n > 0) this.perClient.set(k, n); else this.perClient.delete(k);
            this.head++;
        }
        if(this.head > 1024 && this.head * 2 > this.times.length){
            this.times   = this.times.slice(this.head);
            this.clients = this.clients.slice(this.head);
            this.head    = 0;
        }
    }

    used(now){
        this.prune(now);
        return this.times.length - this.head;
    }

    // Fair-share admission for a client request about to reach the upstream.
    admits(client, now, limit){
        let total = this.used(now);
        if(total >= limit) return false;
        if(total < Math.floor(limit * EGRESS_SOFT_FRACTION)) return true;
        let active = this.perClient.size + (this.perClient.has(client) ? 0 : 1);
        return (this.perClient.get(client) || 0) < limit / active;
    }

    record(client, now){
        this.times.push(now);
        this.clients.push(client);
        this.perClient.set(client, (this.perClient.get(client) || 0) + 1);
    }

    // Whole seconds until the oldest call in the window ages out.
    retryAfter(now){
        if(this.head >= this.times.length) return 1;
        return Math.max(1, Math.ceil((this.times[this.head] + EGRESS_WINDOW_MS - now) / 1000));
    }
}

// One budget per upstream URL, held in the map the caller owns, so the indexer's
// and the tracker's budgets never mix.
function budgetIn(budgets, url){
    let key = String(url || '');
    let b = budgets.get(key);
    if(!b){ b = new EgressBudget(); budgets.set(key, b); }
    return b;
}

module.exports = { EgressBudget, budgetIn, EGRESS_WINDOW_MS, INTERNAL_CLIENT };
