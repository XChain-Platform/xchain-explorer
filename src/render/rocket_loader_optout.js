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
 * XChain Explorer - keep Cloudflare Rocket Loader off the explorer's scripts
 *
 * The zone in front of production runs Rocket Loader, which rewrites every
 * script tag it sees, holds them until the window load event and then runs
 * them one at a time. With about 35 scripts that held a warm-cache page about
 * 2.4 s before its first data request, and it overrides the explorer's own
 * blocking and defer choices (src/render/page_assets.js). Rocket Loader leaves
 * any script tag carrying data-cfasync="false" alone, so every script tag on a
 * rendered page, inline ones included, gets that attribute here, which keeps
 * the page's script order exactly as the template wrote it and touches no other
 * site on the zone.
 *
 ********************************************************************/

'use strict';

// <script ...> opening tags that do not already name data-cfasync.
const SCRIPT_OPEN = /<script\b(?![^>]*\bdata-cfasync=)/gi;

function optOutOfRocketLoader(html){
    return String(html).replace(SCRIPT_OPEN, '<script data-cfasync="false"');
}

module.exports = { optOutOfRocketLoader };
