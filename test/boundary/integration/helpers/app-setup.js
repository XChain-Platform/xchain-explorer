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
 * Boundary integration test helper. The boundary suite boots the same app
 * against the same fixture database as the base integration suite, so it
 * uses that suite's helper rather than a copy of it. The copy this replaces
 * had drifted: it hardcoded the container fixture's credentials and lacked
 * the co-located hub DB and tip-age escapes, so explorer.init() refused to
 * start once ci-full ran this tier.
 */

'use strict';

module.exports = require('../../../integration/helpers/app-setup.js');
