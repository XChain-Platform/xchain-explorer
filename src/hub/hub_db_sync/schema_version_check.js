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
 **********************************************************************/

'use strict';

const { HUB_SCHEMA_VERSION } = require('../hub_schema_version');

function hasExpectedSchemaVersion(schemaVersion) {
    return schemaVersion === HUB_SCHEMA_VERSION;
}

function schemaVersionLabel(schemaVersion) {
    return schemaVersion == null ? 'missing' : String(schemaVersion);
}

if (!hasExpectedSchemaVersion(HUB_SCHEMA_VERSION) ||
    hasExpectedSchemaVersion(undefined) ||
    hasExpectedSchemaVersion(null) ||
    hasExpectedSchemaVersion(HUB_SCHEMA_VERSION + 1))
    throw new Error('Hub mirror schema-version refusal check is invalid');

module.exports = { hasExpectedSchemaVersion, schemaVersionLabel };
