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
 * XChain Explorer - rate limiter counter line
 *
 * A limiter that refuses silently is invisible: an operator watching a wallet
 * fail sees timeouts and has nothing in the service log tying them to a
 * ceiling, so the first diagnosis is always the wrong subsystem. This turns
 * every limiter into one that says which knob refused and by how much.
 *
 * A throttled client retries hard by definition, so one line per refusal
 * would turn a burst into its own log outage. Instead refusals are counted
 * and at most one line is emitted per window, carrying the count since the
 * previous line. The window is measured against the clock at refusal time
 * rather than a timer, because a timer would keep the event loop alive and
 * an idle explorer must still be able to exit.
 *
 * express-rate-limit 8.x sets the draft-6 RateLimit-* headers and Retry-After
 * BEFORE it calls a custom handler, but the handler then owns the status and
 * the body (the default it replaces is status(statusCode).send(message)), so
 * this sends the same JSON body the `message` option carried.
 *
 ********************************************************************/

'use strict';

/**
 * Build an express-rate-limit `handler` that answers 429 and keeps a counter.
 *
 * `log` and `now` are injectable so the counting and window behaviour can be
 * asserted without real clocks or timers.
 */
function limitedHandler({ service, name, envVar, limit, windowMs, message, log = console.warn, now = Date.now }) {

    // Refusals seen since the last line, and when that line went out. `null`
    // rather than 0 so the very first refusal always logs, whatever epoch the
    // injected clock starts at.
    let refusedSinceLine = 0;
    let lastLineAt       = null;

    const windowSeconds = Math.round(windowMs / 1000);

    return function rateLimitedHandler(req, res, next, options) {
        refusedSinceLine++;

        res.status(429).json(message);

        const at = now();
        if(lastLineAt !== null && at - lastLineAt < windowMs) return;

        lastLineAt = at;
        log(service + ' rate limit [' + name + ']: ' + refusedSinceLine +
            ' request' + (refusedSinceLine === 1 ? '' : 's') +
            ' refused in the last ' + windowSeconds + ' s' +
            ' (limit ' + limit + '/' + windowSeconds + ' s); raise ' + envVar +
            ' if this is legitimate traffic');
        refusedSinceLine = 0;
    };
}

module.exports = { limitedHandler };
