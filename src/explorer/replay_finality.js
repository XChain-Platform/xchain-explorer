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
 * XChain Explorer - replay finality rules
 *
 * Pure parsing and finality decisions for the indexer's replay status body.
 *
 ********************************************************************/

'use strict';

const REPLAY_STATES = Object.freeze(['pending', 'replaying', 'replayed']);

function replayIsOpen(replay){
    return Boolean(replay && (replay.state === 'pending' || replay.state === 'replaying'));
}

function heightIsFinal(height, replay){
    return !replayIsOpen(replay) || Number(height) < Number(replay.target);
}

function parseReplay(rules){
    if(!rules || rules.replay == null) return null;

    const replay = rules.replay;
    if(!REPLAY_STATES.includes(replay.state))
        throw new TypeError(`Invalid replay state: ${replay.state}`);

    const target = Number(replay.target);
    if(!Number.isSafeInteger(target) || target < 0)
        throw new RangeError(`Invalid replay target: ${replay.target}`);

    return {
        state: replay.state,
        target,
        replay_to: replay.replay_to === null ? null : Number(replay.replay_to)
    };
}

module.exports = { REPLAY_STATES, replayIsOpen, heightIsFinal, parseReplay };
