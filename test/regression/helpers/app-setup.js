/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available —
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * Regression test helper — reuses the integration app setup.
 *
 * Boots the explorer against the test MariaDB and returns a
 * supertest-compatible Express app instance.
 */

'use strict';

const { createApp, createTestConfigInfo } = require('../../integration/helpers/app-setup');

module.exports = { createApp, createTestConfigInfo };
