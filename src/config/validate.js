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
 * XChain Explorer - config admission checks
 *
 * One part of src/config.js (the entry requires it directly). Pure predicates:
 * they read the document the hub or the standalone path produced and say what
 * it is, and the entry decides what to do about it. The utility that owns
 * isNull/throwError is passed in rather than required here, so the config
 * suite's proxyquire stub of ./lib/utility.js on the entry still governs.
 *
 ********************************************************************/

'use strict';

/**
 * Classify a hub config response before anything downstream trusts it.
 *
 * @param {object} configUtil the explorer utility instance (isNull)
 * @param {*} jsonConfig whatever the hub connector returned
 * @returns {{unreachable: boolean, returnedNothing: boolean, cause: string}}
 */
function describeHubResponse(configUtil, jsonConfig){
    // Detect an unusable hub response (null after all retries, or an
    // empty object) up front so a hub outage never tears down a
    // working config or hard-fails startup.
    const unreachable = configUtil.isNull(jsonConfig);
    const returnedNothing = unreachable ||
        (typeof jsonConfig === 'object' && Object.keys(jsonConfig).length === 0);

    // A hub that answers with an empty tree is NOT down: it is up and has no
    // coin config yet, which is the normal state while a stack is still being
    // installed. Reporting both as "unreachable" sends operators after a
    // network fault that does not exist.
    const cause = unreachable
        ? 'Hub unreachable (all endpoints failed after retries)'
        : 'Hub reachable but serving no coin config';

    return { unreachable, returnedNothing, cause };
}

/**
 * Refuse to run without a usable config, whichever source supplied it. Throws
 * through the utility so the message and the error shape stay the explorer's.
 *
 * @param {object} configUtil the explorer utility instance (isNull, throwError)
 * @param {*} jsonConfig the document about to be turned into a config
 */
function requireUsableConfig(configUtil, jsonConfig){
    if(configUtil.isNull(jsonConfig))
        configUtil.throwError('No valid configuration information detected');
}

module.exports = { describeHubResponse, requireUsableConfig };
