'use strict';

/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
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
 * XChain Explorer - windowed outage logging
 *
 * A hub outage under load fails every request the same way, so a line written per
 * failure grows with the request rate. This writes the first line of an event class
 * at once, counts the rest, and puts the count on the next window's first line as
 * `suppressed`. Only the very first line of a class carries a stack; later windows
 * keep the message and code, since the stack is the same. The failure itself is
 * still handled per request by the caller; only the log volume is bounded.
 *
 ********************************************************************/

const DEFAULT_WINDOW_MS = 60000;

// Per-owner state so each connector, cache or process host keeps its own windows
// and a test builds a fresh one by building a fresh owner.
const states = new WeakMap();
const sharedOwner = {};

function stateFor(owner){
    const o = (owner && typeof owner === 'object') ? owner : sharedOwner;
    let s = states.get(o);
    if(!s){ s = new Map(); states.set(o, s); }
    return s;
}

/**
 * Log `event` through `logger[level]` at most once per window per (owner, event).
 * `stack` is attached only to the first line this owner ever writes for the event.
 * Returns true when a line was written, false when it was counted.
 */
function logWindowed(owner, logger, level, event, fields, { stack = null, windowMs = DEFAULT_WINDOW_MS } = {}){
    const s = stateFor(owner);
    const now = Date.now();
    const w = s.get(event);
    // A clock that stepped back opens a new window rather than silencing the event.
    if(w && now >= w.start && now - w.start < windowMs){
        w.suppressed++;
        return false;
    }
    const line = Object.assign({}, fields);
    if(w && w.suppressed > 0) line.suppressed = w.suppressed;
    if(stack && !(w && w.stackSent)) line.stack = stack;
    s.set(event, { start: now, suppressed: 0, stackSent: !!(w && w.stackSent) || !!stack });
    logger[level](event, line);
    return true;
}

module.exports = { logWindowed, DEFAULT_WINDOW_MS };
