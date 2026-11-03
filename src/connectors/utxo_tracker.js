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
 * XChain Explorer - UTXO tracker read connector
 *
 * The one call the explorer makes to a coin's xchain-utxo-tracker: GET
 * /info/<address>, the live native balance and UTXO figures an address page
 * and every balances batch entry carry.
 *
 * The tracker rate-limits per connecting IP (UTXO_TRACKER_RATE_LIMIT_RPM,
 * default 500 a minute) and this whole process is one IP to it, while a
 * balances batch spends up to twenty reads. Left alone, a few distinct clients
 * each well inside their own explorer limits drain that one bucket and every
 * client's answers lose their tracker figures. So, as the indexer connector
 * does, the explorer keeps its own fair-share budget per tracker below the
 * tracker's ceiling (egress_budget.js): a client over its share is answered
 * "unavailable" locally without a call, and a light client keeps its share.
 * A 429 that still comes back pauses that tracker for its Retry-After, and the
 * unavailable warn line is aggregated per tracker per minute rather than one
 * line per refused read.
 *
 ********************************************************************/

'use strict';

const { budgetIn, INTERNAL_CLIENT } = require('./egress_budget.js');
// Resolved at require time: getLogger() reaches the real shipper once api.js
// has installed observability and falls through to bare console.* before that.
const { getLogger } = require('../observability');
const log = getLogger();

// Below the tracker's default 500 a minute, leaving room for the odd read that
// slips between the admission check and the call. EXPLORER_TRACKER_EGRESS_RPM
// overrides it for a tracker run with a different UTXO_TRACKER_RATE_LIMIT_RPM.
const DEFAULT_EGRESS_RPM  = 450;
const FETCH_TIMEOUT_MS    = 6000;
// Pause after an upstream 429: its Retry-After in seconds, clamped to this range.
const COOLDOWN_MIN_MS     = 1000;
const COOLDOWN_MAX_MS     = 60 * 1000;
const WARN_WINDOW_MS      = 60 * 1000;

// Every map below is keyed by tracker base URL, which comes from configuration,
// so each holds one entry per configured tracker and cannot grow with traffic.
const egressBudgets = new Map();   // tracker base -> EgressBudget
const cooldownUntil = new Map();   // tracker base -> epoch ms the 429 pause ends
const warnState     = new Map();   // tracker base -> counts since the last line

function egressLimit(env){
    let n = parseInt(env && env.EXPLORER_TRACKER_EGRESS_RPM, 10);
    return n > 0 ? n : DEFAULT_EGRESS_RPM;
}

// Retry-After in the seconds form express-rate-limit sends; anything else takes
// the minimum.
function cooldownMs(retryAfter){
    const s = String(retryAfter == null ? '' : retryAfter).trim();
    if(!/^[0-9]{1,6}$/.test(s)) return COOLDOWN_MIN_MS;
    return Math.min(Math.max(Number(s) * 1000, COOLDOWN_MIN_MS), COOLDOWN_MAX_MS);
}

// Count one unavailable answer and log at most one UTXO_TRACKER_UNAVAILABLE line
// per tracker per window. The first one logs at once; the next line carries the
// counts since the last: `failed` (the tracker was asked and did not answer) and
// `shed` (not asked: over the client's share, or inside a 429 pause). Returns null,
// the reader's "no tracker figures" answer.
function noteUnavailable(base, coin, kind, err){
    let s = warnState.get(base);
    if(!s){ s = { lastAt: null, failed: 0, shed: 0 }; warnState.set(base, s); }
    s[kind]++;
    const now = Date.now();
    if(s.lastAt !== null && now - s.lastAt < WARN_WINDOW_MS) return null;
    log.warn('UTXO_TRACKER_UNAVAILABLE', { method: 'getAddressTrackerInfo', code: coin, err, failed: s.failed, shed: s.shed });
    Object.assign(s, { lastAt: now, failed: 0, shed: 0 });
    return null;
}

async function fetchInfo(base, address){
    const url = base.replace(/\/+$/, '') + '/info/' + encodeURIComponent(address);
    const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if(res.status === 429)
        cooldownUntil.set(base, Date.now() + cooldownMs(res.headers && res.headers.get('retry-after')));
    if(!res.ok) throw new Error('HTTP ' + res.status);
    const j = await res.json();
    if(j && j.balances && j.utxos) return j;
    throw new Error('malformed /info response');
}

// The tracker's /info answer for `address`, or null when it is unavailable to this
// caller right now. `client` is the end client the read is made for (its IP), or
// absent for a read no client caused; `env` is the caller's live env view.
async function readTrackerInfo({ base, address, client, coin, env }){
    const now = Date.now();
    if(now < (cooldownUntil.get(base) || 0))
        return noteUnavailable(base, coin, 'shed', 'HTTP 429 (paused for Retry-After)');
    const key    = String(client || INTERNAL_CLIENT);
    const budget = budgetIn(egressBudgets, base);
    if(!budget.admits(key, now, egressLimit(env)))
        return noteUnavailable(base, coin, 'shed', 'tracker egress budget (client over its fair share)');
    budget.record(key, now);
    try {
        return await fetchInfo(base, address);
    } catch(e){
        return noteUnavailable(base, coin, 'failed', e && e.message ? e.message : e);
    }
}

// Forget every window, pause and log count. For suites, which share this module.
function resetTrackerEgress(){
    egressBudgets.clear();
    cooldownUntil.clear();
    warnState.clear();
}

module.exports = { readTrackerInfo, resetTrackerEgress };
