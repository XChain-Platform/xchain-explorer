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
 * XChain Explorer - cache lifetimes for disk-served files
 *
 * express.static answers with max-age=0 by default, so neither Cloudflare nor
 * the browser kept any of the hundred or so scripts and stylesheets a page
 * loads: every page view refetched all of them through the edge to the origin,
 * and that round trip, not the database, was most of a page's load time.
 *
 * A URL carrying ?v=<content hash> (src/render/asset_version.js) names one exact
 * byte sequence, so it is safe to keep forever. A bare URL (the theme tokens,
 * Font Awesome, anything a script builds by hand) can change on a deploy, so it
 * keeps a short lifetime that still spares a visitor's next few pages.
 *
 ********************************************************************/

'use strict';

const VERSIONED = 'public, max-age=31536000, immutable';
const UNVERSIONED = 'public, max-age=300';

// express.static setHeaders hook; res.req is the request being answered.
function setStaticCacheHeaders(res){
    const query = (res.req && res.req.query) || {};
    res.setHeader('Cache-Control', typeof query.v === 'string' && query.v !== '' ? VERSIONED : UNVERSIONED);
}

// The options object every disk mount passes to express.static.
const STATIC_OPTIONS = { setHeaders: setStaticCacheHeaders };

module.exports = { STATIC_OPTIONS, setStaticCacheHeaders, VERSIONED, UNVERSIONED };
