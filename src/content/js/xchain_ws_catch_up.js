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
 * `not_replayed` types dispatches `not_replayed` with them; a blocks
 * subscription shares the queue, so its COMPLETE names NEW_BLOCK.
 *
 * It also holds the cursor tracking every frame passes through (a REORG frame
 * moves the cursor back below the rollback) and the outbound pacing that keeps
 * every send under the server's per-connection message rate, with a plain
 * subscribe the server drops with RATE_LIMITED sent again.
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
    // drops below it, so a reconnect before the replacements arrive replays them.
    if (msg.type === 'REORG') {
        client._rewindCursor(msg.data.first_invalid_action_index);
        return;
    }
    // Only NEW_ACTION and CATCH_UP_COMPLETE report a delivered action row; other frames
    // reuse action_index for an entity id, and moving the cursor to one skips rows.
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

// The larger of two action indexes, compared as BigInt and kept as a decimal string;
// a value that is not a non-negative integer literal is ignored.
function xcWsMaxIndex(current, raw) {
    if (raw === null || raw === undefined) return current;
    var val = String(raw);
    if (!/^[0-9]+$/.test(val)) return current;
    return (current === null || BigInt(val) > BigInt(current)) ? val : current;
}

// Only a subscription naming the actions or address channel has NEW_ACTION to replay.
function xcWsCarriesActions(channels) {
    if (!Array.isArray(channels)) return false;
    for (var i = 0; i < channels.length; i++) {
        if (channels[i] === 'actions' || channels[i] === 'address') return true;
    }
    return false;
}

// A subscription the reconnect sends with since_action_index: one that can carry
// NEW_ACTION, or one naming blocks, whose COMPLETE reports NEW_BLOCK as not replayed.
function xcWsNeedsCatchUp(channels) {
    return xcWsCarriesActions(channels) || (Array.isArray(channels) && channels.indexOf('blocks') !== -1);
}

// The cursor just below a rollback's first invalidated index, or `current` when that
// is already lower or either side is not an index.
function xcWsBelowIndex(current, firstInvalid) {
    if (current === null || firstInvalid === null || firstInvalid === undefined) return current;
    var val = String(firstInvalid);
    if (!/^[0-9]+$/.test(val) || BigInt(val) === 0n) return current;
    var below = BigInt(val) - 1n;
    return (BigInt(current) > below) ? String(below) : current;
}

// The id an address is compared by: the server keys a recognized bech32 address in
// lowercase, and bech32 allows one case per address.
function xcWsAddressId(address) {
    var s = String(address);
    return /^[a-z0-9]+1[ac-hj-np-z02-9]{6,}$/i.test(s) && (s === s.toLowerCase() || s === s.toUpperCase()) ? s.toLowerCase() : s;
}

// The server keys of one channel in a request, each with the params naming just it.
function xcWsKeysOf(channel, p) {
    var names = XC_WS_ENTITY_NAMES[channel], list;
    if (channel === 'market') list = Array.isArray(p.pairs) ? p.pairs :
        (p.tick1 !== undefined && p.tick2 !== undefined ? [[p.tick1, p.tick2]] : []);
    else if (!names) return [{ id: '', set: {} }];
    else if (names[2]) list = p[names[0]] !== undefined ? [p[names[0]]] : (p[names[1]] || []);
    else list = Array.isArray(p[names[1]]) ? p[names[1]] : (p[names[0]] !== undefined ? [p[names[0]]] : []);
    return list.map(function(v) {
        var set = {};
        if (channel === 'market') { set.tick1 = v[0]; set.tick2 = v[1]; } else set[names[0]] = v;
        var id = channel === 'market' ? v[0] + '|' + v[1] : String(v);
        if (channel === 'xcall') id = id.toLowerCase(); else if (channel === 'address') id = xcWsAddressId(id);
        return { id: id, set: set };
    });
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
    // Resends of one catch-up request refused with RATE_LIMITED or CATCH_UP_NOT_READY.
    catchUpRateRetries: 5,

    // Resubscribe from the saved cursor, one replay at a time.
    _resubscribe: function() {
        if (this.subscriptions.length === 0) {
            this._autoSubscribe();
            return;
        }
        // Zero is a real position; only a never-seeded null cursor omits replay.
        var cursor = this.lastActionIndex !== null ? this.lastActionIndex : null;
        var queue  = [];
        var live   = [];
        for (var j = 0; j < this.subscriptions.length; j++) live.push.apply(live, this._liveRequests(this.subscriptions[j]));
        for (var i = 0; i < live.length; i++) {
            var sub = live[i];
            if (cursor !== null && xcWsNeedsCatchUp(sub.channels)) {
                queue.push(sub);
                continue;
            }
            // Paced by _send and retried on RATE_LIMITED.
            this._sendSubscribe(sub.channels, Object.assign({}, sub.params), 0, sub.owner);
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
    _sendSubscribe: function(channels, params, attempt, owner) {
        var msg = { action: 'subscribe', channels: channels, id: 'sub-' + (++this._subscribeSeq) };
        if (params) msg.params = params;
        this._pendingSubscribes[msg.id] = { channels: channels, params: params, attempt: attempt || 0, owner: owner };
        this._send(msg);
    },

    // Retry only the keys the owning tracked subscription still holds.
    _retrySubscribe: function(pending) {
        if (pending.attempt >= this.subscribeRetries) return;
        var owner = null;
        for (var i = 0; i < this.subscriptions.length; i++) {
            if (this.subscriptions[i].channels === pending.channels || this.subscriptions[i] === pending.owner)
                owner = this.subscriptions[i];
        }
        if (!owner) return;
        var self = this;
        setTimeout(function() {
            if (self.subscriptions.indexOf(owner) === -1) return;
            var request = { channels: pending.channels, params: pending.params, spent: owner.spent, removed: owner.removed };
            var live = self._liveRequests(request);
            for (var i = 0; i < live.length; i++)
                self._sendSubscribe(live[i].channels, live[i].params, pending.attempt + 1, owner);
        }, Math.ceil(1000 / this._messageRate()));
    },

    // Remember a once subscription the server spent, so a reconnect does not arm it again.
    _noteOnceSpent: function(data) {
        var key = xcWsFrameKey(data);
        for (var i = 0; i < this.subscriptions.length; i++) {
            var sub = this.subscriptions[i];
            if (sub.params && sub.params.once && sub.channels.indexOf(data.channel) !== -1) (sub.spent = sub.spent || {})[key] = true;
        }
    },

    // Return one request per key after any once-spent or removed keys are excluded.
    _liveRequests: function(sub) {
        if (!sub.spent && !sub.removed) return [sub];
        var out = [];
        for (var c = 0; c < sub.channels.length; c++) {
            var keys = xcWsKeysOf(sub.channels[c], sub.params);
            for (var k = 0; k < keys.length; k++) {
                var key = sub.channels[c] + ':' + keys[k].id;
                if ((sub.spent && sub.spent[key]) || (sub.removed && sub.removed[key])) continue;
                var params = {};
                for (var name in sub.params) if (XC_WS_ENTITY_PARAMS.indexOf(name) === -1) params[name] = sub.params[name];
                out.push({ channels: [sub.channels[c]], params: Object.assign(params, keys[k].set), owner: sub });
            }
        }
        return out;
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
