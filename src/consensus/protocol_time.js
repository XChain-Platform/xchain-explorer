/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
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
 * Protocol time used by display-side consensus projections.
 ********************************************************************/

'use strict';

const MEDIAN_TIME_SPAN = 11;

const PROTOCOL_TIME_MTP_NETWORKS = Object.freeze({
    mainnet: false,
    testnet: true,
    regtest: false,
});

function isProtocolTimeMtpActive(network){
    return PROTOCOL_TIME_MTP_NETWORKS[network] === true;
}

function medianTimePast(previousBlockTimes){
    if(!Array.isArray(previousBlockTimes)) return null;
    let times = previousBlockTimes
        .slice(0, MEDIAN_TIME_SPAN)
        .map(Number)
        .filter((time) => Number.isFinite(time) && time > 0);
    if(times.length === 0) return null;
    times.sort((a, b) => a - b);
    return times[Math.floor(times.length / 2)];
}

function protocolTime(network, blockTime, previousBlockTimes){
    if(blockTime === false || blockTime === null || blockTime === undefined)
        return blockTime;
    let raw = Number(blockTime);
    if(!Number.isFinite(raw)) return blockTime;
    if(!isProtocolTimeMtpActive(network)) return raw;
    let median = medianTimePast(previousBlockTimes);
    return median === null ? raw : Math.min(median, raw);
}

module.exports = {
    MEDIAN_TIME_SPAN,
    PROTOCOL_TIME_MTP_NETWORKS,
    isProtocolTimeMtpActive,
    medianTimePast,
    protocolTime
};
