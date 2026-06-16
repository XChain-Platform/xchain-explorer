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
 * Regression test helper — reuses the integration DB setup.
 *
 * Regression tests use the same baseline seed as integration tests
 * to maintain a stable, version-controlled reference dataset.
 */

'use strict';

const db = require('../../integration/helpers/db-setup');

module.exports = db;
