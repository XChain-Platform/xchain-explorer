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
 * XChain Explorer - WebSocket Client, reconnect catch-up
 *
 * Installs the reconnect resubscribe onto XChainWS (xchain_ws.js, which the
 * page loads first). The server runs one catch-up per client and refuses an
 * overlapping one, so each subscription that can carry NEW_ACTION replays
 * from the reconnect-time cursor in turn. A truncated replay is continued
 * from where it stopped; one refused with RATE_LIMITED is sent again; one
 * refused otherwise or unanswered dispatches `resync_required` so the page can
 * reload over REST. A completed replay whose CATCH_UP_COMPLETE lists
 * `not_replayed` types dispatches `not_replayed` with them. A blocks
 * subscription goes through the same queue, so its COMPLETE names NEW_BLOCK,
 * which no replay carries.
 *
 * It also holds what that resubscribe leans on: the cursor tracking every
 * frame passes through (a REORG frame moves the cursor back below the
 * rollback), and the outbound pacing that keeps every send, a long
 * resubscribe included, under the server's per-connection message rate, with
 * a plain subscribe the server drops with RATE_LIMITED sent again.
 *
 ********************************************************************/

// Track latest action_index for catch-up on reconnect. WELCOME only seeds an unset
// cursor: its tip runs ahead of rows a reconnect replay has yet to deliver. While that
// replay runs, frames are noted in _catchUp.maxSeen and applied once it closes.
function xcWsTrackCursor(client, msg) {
    if (!msg.data) return;
    if (msg.type === 'WELCOME') {
        if (client.lastActionIndex === null) client._advanceCursor(msg.data.latest_action_index);
        return;
    }
    // A rollback voids every row at or above first_invalid_action_index: the cursor
    // drops below it, so the replacement rows that follow move it forward again and a
    // reconnect before they arrive replays them.
    if (msg.type === 'REORG') {
        client._rewindCursor(msg.data.first_invalid_action_index);
        return;
    }
    // Only NEW_ACTION and CATCH_UP_COMPLETE report a delivered action row. Other frames
    // reuse action_index for an entity id (a dispenser, a bet feed), and moving the
    // cursor to one would make the next reconnect skip rows this client never received.
    var raw;
    if (msg.type === 'NEW_ACTION') raw = msg.data.action_index;
    else if (msg.type === 'CATCH_UP_COMPLETE') raw = msg.data.latest_action_index;
    else return;
    if (client._catchUp) {
        client._catchUp.maxSeen = xcWsMaxIndex(client._catchUp.maxSeen, raw);
        return;
    }
    client._advanceCursor(raw);
}

// The larger of two action indexes, compared as BigInt and kept as the wire's decimal
// string. A value that is not a non-negative integer literal is ignored (null included).
function xcWsMaxIndex(current, raw) {
    if (raw === null || raw === undefined) return current;
    var val = String(raw);
    if (!/^[0-9]+$/.test(val)) return current;
    return (current === null || BigInt(val) > BigInt(current)) ? val : current;
}

// Only the actions and address channels ever carry NEW_ACTION, so only a subscription
// naming one of them has anything for a catch-up to replay.
function xcWsCarriesActions(channels) {
    if (!Array.isArray(channels)) return false;
    for (var i = 0; i < channels.length; i++) {
        if (channels[i] === 'actions' || channels[i] === 'address') return true;
    }
    return false;
}

// A subscription the reconnect sends with since_action_index: one that can carry
// NEW_ACTION (replayed), or one naming blocks, whose COMPLETE tells the page that the
// NEW_BLOCK frames it missed are not replayed.
function xcWsNeedsCatchUp(channels) {
    return xcWsCarriesActions(channels) || (Array.isArray(channels) && channels.indexOf('blocks') !== -1);
}

// The cursor just below a rollback's first invalidated index, or `current` when that
// is already lower (or either side is not an index). Kept as the wire's decimal string.
function xcWsBelowIndex(current, firstInvalid) {
    if (current === null || firstInvalid === null || firstInvalid === undefined) return current;
    var val = String(firstInvalid);
    if (!/^[0-9]+$/.test(val) || BigInt(val) === 0n) return current;
    var below = BigInt(val) - 1n;
    return (BigInt(current) > below) ? String(below) : current;
}

Object.assign(XChainWS, {
    // Outbound pacing. The server drops a message over its per-connection rate
    // (WELCOME's limits.max_message_rate, a leaky bucket draining at that many per
    // second) with RATE_LIMITED, so every frame waits in _outQueue until this client's
    // own copy of that bucket has room, one slot short of the server's for timing slack.
    // A reconnect with many tracked subscriptions would otherwise send them in one tick
    // and lose every one past the rate.
    defaultMessageRate:   10,
    _outQueue:            [],
    _outLevel:            0,
    _outAt:               0,
    _outTimer:            null,
    // Plain subscribes awaiting their answer, by request id, so one the server refused
    // with RATE_LIMITED is sent again (_retrySubscribe), at most subscribeRetries times.
    _pendingSubscribes:   {},
    _subscribeSeq:        0,
    subscribeRetries:     5,

    _catchUpSeq:      0,
    catchUpTimeoutMs: 30000,
    catchUpMaxRounds: 20,
    // How many times one catch-up request refused with RATE_LIMITED or
    // CATCH_UP_NOT_READY is sent again.
    catchUpRateRetries: 5,

    // Resubscribe to all tracked subscriptions (after reconnect). With a cursor to resume
    // from, each subscription that can carry NEW_ACTION replays from it ONE AT A TIME,
    // since the server runs one catch-up per client and refuses an overlapping one.
    _resubscribe: function() {
        if (this.subscriptions.length === 0) {
            this._autoSubscribe();
            return;
        }
        // Same gate as before the cursor became a string: a chain still at index 0
        // gets no since_action_index.
        var cursor = (this.lastActionIndex !== null && BigInt(this.lastActionIndex) > 0n) ? this.lastActionIndex : null;
        var queue  = [];
        for (var i = 0; i < this.subscriptions.length; i++) {
            var sub = this.subscriptions[i];
            if (cursor !== null && xcWsNeedsCatchUp(sub.channels)) {
                queue.push(sub);
                continue;
            }
            // Paced by _send and retried on RATE_LIMITED (xchain_ws.js), so a long
            // subscription list cannot outrun the server's message rate.
            this._sendSubscribe(sub.channels, Object.assign({}, sub.params));
        }
        if (queue.length > 0) {
            this._catchUp = { queue: queue, cursor: cursor, current: null, maxSeen: null, timer: null };
            this._nextCatchUp();
        }
    },

    // Send the next queued subscription with its catch-up, or close the reconnect's
    // catch-up when none remain.
    _nextCatchUp: function() {
        var state = this._catchUp;
        if (!state) return;
        var sub = state.queue.shift();
        if (!sub) {
            this._finishCatchUp();
            return;
        }
        state.current = { sub: sub, rounds: 0, id: null, since: null, rateRetries: 0 };
        this._sendCatchUp(state.cursor);
    },

    // (Re)send the current subscription with since_action_index and a fresh request id,
    // which the server echoes on the CATCH_UP_COMPLETE or error that answers it.
    _sendCatchUp: function(since) {
        var state   = this._catchUp;
        var current = state.current;
        var params  = Object.assign({}, current.sub.params);
        params.since_action_index = since;
        current.id    = 'catchup-' + (++this._catchUpSeq);
        current.since = since;
        this._clearCatchUpTimer();
        // Backstop: a replay that fails server-side may send nothing, so an unanswered
        // request is treated as refused instead of stalling the queue behind it.
        var self = this;
        state.timer = setTimeout(function() {
            self._catchUpRefused('CATCH_UP_TIMEOUT', 'No reply to the catch-up request');
        }, this.catchUpTimeoutMs);
        this._send({ action: 'subscribe', channels: current.sub.channels, params: params, id: current.id });
    },

    // Handle a CATCH_UP_COMPLETE or error frame; only one carrying the pending request's
    // id is an answer to it.
    _catchUpAnswered: function(msg) {
        var state = this._catchUp;
        if (!state || !state.current || msg.id === undefined || msg.id !== state.current.id) return;
        if (msg.type === 'error') {
            var err = msg.data || {};
            // Dropped over the message rate, or asked to wait for the coin's first live
            // position, not refused: send the same request again once the server's
            // bucket has drained a slot (RATE_LIMITED) or after a second (CATCH_UP_NOT_READY).
            if ((err.code === 'RATE_LIMITED' || err.code === 'CATCH_UP_NOT_READY') &&
                state.current.rateRetries < this.catchUpRateRetries) {
                state.current.rateRetries++;
                this._clearCatchUpTimer();
                var self = this, since = state.current.since;
                state.timer = setTimeout(function() {
                    if (self._catchUp === state) self._sendCatchUp(since);
                }, err.code === 'RATE_LIMITED' ? Math.ceil(1000 / this._messageRate()) : 1000);
                return;
            }
            this._catchUpRefused(err.code, err.message, err);
            return;
        }
        var data = msg.data || {};
        // The server stopped at its row cap: continue from where it stopped. A once
        // subscription already spent by a replayed frame is not re-armed.
        var spentOnce = state.current.sub.params && state.current.sub.params.once && data.events_replayed > 0;
        if (data.truncated === true && !spentOnce) {
            if (++state.current.rounds >= this.catchUpMaxRounds) {
                this._catchUpRefused('CATCH_UP_ROUNDS', 'Catch-up did not reach the tip in ' + this.catchUpMaxRounds + ' rounds');
                return;
            }
            this._sendCatchUp(data.latest_action_index);
            return;
        }
        this._clearCatchUpTimer();
        if (Array.isArray(data.not_replayed) && data.not_replayed.length > 0) {
            this._dispatch('not_replayed', {
                types:              data.not_replayed.slice(),
                channels:           state.current.sub.channels,
                since_action_index: state.current.since
            });
        }
        this._nextCatchUp();
    },

    // The pending catch-up was refused or went unanswered, so its rows were not replayed:
    // tell the page with a resync_required event (reload over REST), then move on.
    _catchUpRefused: function(code, message, detail) {
        var state = this._catchUp;
        if (!state || !state.current) return;
        this._clearCatchUpTimer();
        var event = {
            code:               code || null,
            message:            message || null,
            channels:           state.current.sub.channels,
            since_action_index: state.current.since
        };
        // CATCH_UP_REORGED names the rollback, so the page can reload from its fork.
        if (detail && detail.fork_block_index !== undefined) event.fork_block_index = detail.fork_block_index;
        if (detail && detail.first_invalid_action_index !== undefined) event.first_invalid_action_index = detail.first_invalid_action_index;
        this._dispatch('resync_required', event);
        this._nextCatchUp();
    },

    // Every queued replay has closed: apply the highest index seen while they ran.
    _finishCatchUp: function() {
        var state = this._catchUp;
        this._clearCatchUpTimer();
        this._catchUp   = null;
        this.catchingUp = false;
        if (state) this._advanceCursor(state.maxSeen);
    },

    // Send one plain subscribe with a request id and remember it until it is answered,
    // so a RATE_LIMITED refusal naming that id can be retried.
    _sendSubscribe: function(channels, params, attempt) {
        var msg = { action: 'subscribe', channels: channels, id: 'sub-' + (++this._subscribeSeq) };
        if (params) msg.params = params;
        this._pendingSubscribes[msg.id] = { channels: channels, params: params, attempt: attempt || 0 };
        this._send(msg);
    },

    // Send a rate-limited subscribe again under a fresh id, after one drain interval.
    // A subscription untracked meanwhile is not revived.
    _retrySubscribe: function(pending) {
        if (pending.attempt >= this.subscribeRetries) return;
        var tracked = false;
        for (var i = 0; i < this.subscriptions.length; i++) {
            if (this.subscriptions[i].channels === pending.channels) tracked = true;
        }
        if (!tracked) return;
        var self = this;
        setTimeout(function() {
            self._sendSubscribe(pending.channels, pending.params, pending.attempt + 1);
        }, Math.ceil(1000 / this._messageRate()));
    },

    // The server's advertised per-connection message rate, or the default before WELCOME.
    _messageRate: function() {
        var limits = this.serverInfo && this.serverInfo.limits;
        var rate = limits && Number(limits.max_message_rate);
        return (rate && rate > 0) ? rate : this.defaultMessageRate;
    },

    // Send queued messages while the local bucket has room, then wait one drain
    // interval for the next slot. Messages queued for a socket that closed are dropped:
    // the reconnect resubscribes from the tracked list.
    _drainOut: function() {
        if (this._outTimer) return;
        var rate     = this._messageRate();
        var capacity = Math.max(1, rate - 1);
        while (this._outQueue.length > 0) {
            if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
                this._outQueue = [];
                return;
            }
            var now = Date.now();
            this._outLevel = Math.max(0, this._outLevel - ((now - this._outAt) / 1000) * rate);
            this._outAt = now;
            if (this._outLevel + 1 > capacity) break;
            this._outLevel += 1;
            this.ws.send(JSON.stringify(this._outQueue.shift()));
        }
        if (this._outQueue.length === 0) return;
        var self = this;
        this._outTimer = setTimeout(function() {
            self._outTimer = null;
            self._drainOut();
        }, Math.ceil(1000 / rate));
    },

    // Drop everything queued for the last socket, and its bucket: a new connection
    // starts with an empty bucket on the server too.
    _resetOut: function() {
        if (this._outTimer) clearTimeout(this._outTimer);
        this._outTimer = null;
        this._outQueue = [];
        this._outLevel = 0;
        this._outAt    = 0;
        this._pendingSubscribes = {};
    },

    // Move the cursor below a rollback's first invalidated index (a REORG frame). A
    // reconnect catch-up in progress lowers what it has seen too, so closing it cannot
    // carry the cursor back over the rollback.
    _rewindCursor: function(firstInvalid) {
        this.lastActionIndex = xcWsBelowIndex(this.lastActionIndex, firstInvalid);
        if (this._catchUp) this._catchUp.maxSeen = xcWsBelowIndex(this._catchUp.maxSeen, firstInvalid);
    },

    // The answer to a plain subscribe this client sent: a RATE_LIMITED refusal naming it
    // sends it again, any other answer closes it.
    _subscribeAnswered: function(msg) {
        if (!Object.prototype.hasOwnProperty.call(this._pendingSubscribes, msg.id)) return;
        var pending = this._pendingSubscribes[msg.id];
        delete this._pendingSubscribes[msg.id];
        if (msg.type === 'error' && msg.data && msg.data.code === 'RATE_LIMITED') this._retrySubscribe(pending);
    },

    // Cancel the pending request's backstop timer, if one is armed.
    _clearCatchUpTimer: function() {
        if (this._catchUp && this._catchUp.timer) {
            clearTimeout(this._catchUp.timer);
            this._catchUp.timer = null;
        }
    }
});
