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
 ********************************************************************/

'use strict';

const { createHubSelector } = require('../hub/hub_db_sync/hub_selector.js');
const { resolveHubMode, resolveHubSeeds, resolveHubUrl } = require('./url.js');

function buildHubSelector(target, options){
    let mode = resolveHubMode(target);
    if(mode === 'none') return null;

    let selectorOptions = {
        hubSeedUrls: mode === 'seeds' ? resolveHubSeeds(target).join(',') : '',
        hubApiUrl: mode === 'pinned' ? resolveHubUrl(target) : ''
    };
    if(options && Object.prototype.hasOwnProperty.call(options, 'randomInt'))
        selectorOptions.randomInt = options.randomInt;

    return createHubSelector(target && target.network, selectorOptions);
}

module.exports = { buildHubSelector };
