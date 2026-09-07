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
 * The one poll-until wait for the test tree. A test that synchronises on a
 * fixed sleep encodes how fast the box was the day it was written, so the
 * timing assumption is retuned per site forever; this holds the assumption in
 * one place instead.
 *
 * It REJECTS on timeout rather than returning a flag. A wait that gives up
 * quietly turns a flaky test into one that passes unconditionally, which is
 * strictly worse than the flake: the flake at least reported something. The
 * deadline is therefore reachable and reaching it is a failure, named.
 *
 * Use it only where a CONDITION is being waited on. Where the elapsed time is
 * itself the thing under test - a debounce window, a rate-limit interval, a
 * TTL, or a "stayed quiet for N ms" negative - the sleep is the experiment and
 * must stay a sleep; polling there asserts too early and passes for the wrong
 * reason.
 */

'use strict';

/**
 * Poll `predicate` until it is truthy, or reject once `timeout` elapses.
 *
 * Each poll yields a full macrotask turn, so a subject driven by promise
 * chaining or setImmediate advances between checks exactly as it would under a
 * hand-rolled flush loop.
 *
 * @param {() => (boolean|Promise<boolean>)} predicate Condition to wait on.
 * @param {string} what Names the condition; it is what the timeout error reports.
 * @param {{timeout?: number, interval?: number}} [opts]
 * @returns {Promise<void>} Resolves when the predicate held.
 * @throws {Error} When the deadline passes with the predicate still falsy.
 */
async function waitUntil(predicate, what, opts = {}) {
    const timeoutMs  = opts.timeout  === undefined ? 2000 : opts.timeout;
    const intervalMs = opts.interval === undefined ? 5    : opts.interval;
    const deadline   = Date.now() + timeoutMs;
    for (;;) {
        if (await predicate()) return;
        if (Date.now() >= deadline) {
            throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
        }
        await new Promise((r) => setTimeout(r, intervalMs));
    }
}

module.exports = { waitUntil };
