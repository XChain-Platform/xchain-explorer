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
 * from where it stopped; a refused or unanswered one dispatches
 * `resync_required` so the page can reload over REST. A completed replay whose
 * CATCH_UP_COMPLETE lists `not_replayed` types dispatches `not_replayed` with them.
 *
 ********************************************************************/

// Only the actions and address channels ever carry NEW_ACTION, so only a subscription
// naming one of them has anything for a catch-up to replay.
function xcWsCarriesActions(channels) {
    if (!Array.isArray(channels)) return false;
    for (var i = 0; i < channels.length; i++) {
        if (channels[i] === 'actions' || channels[i] === 'address') return true;
    }
    return false;
}

Object.assign(XChainWS, {

    _catchUpSeq:      0,
    catchUpTimeoutMs: 30000,
    catchUpMaxRounds: 20,

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
            if (cursor !== null && xcWsCarriesActions(sub.channels)) {
                queue.push(sub);
                continue;
            }
            this._send({ action: 'subscribe', channels: sub.channels, params: Object.assign({}, sub.params) });
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
        state.current = { sub: sub, rounds: 0, id: null, since: null };
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
            this._catchUpRefused(err.code, err.message);
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
    _catchUpRefused: function(code, message) {
        var state = this._catchUp;
        if (!state || !state.current) return;
        this._clearCatchUpTimer();
        this._dispatch('resync_required', {
            code:               code || null,
            message:            message || null,
            channels:           state.current.sub.channels,
            since_action_index: state.current.since
        });
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

    // Cancel the pending request's backstop timer, if one is armed.
    _clearCatchUpTimer: function() {
        if (this._catchUp && this._catchUp.timer) {
            clearTimeout(this._catchUp.timer);
            this._catchUp.timer = null;
        }
    }
});
