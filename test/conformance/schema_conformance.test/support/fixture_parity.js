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
 */

'use strict';

const { fs, expect, FIXTURE_SCHEMA, FIXTURE_DB, INDEXER_DB } = require('../../schema_conformance.test.js');

/******************************************************************
 * 3. Integration fixture snapshot must not drift from the real DDL
 *****************************************************************/

function registerFixtureParity(runtime) {
    it('integration fixture schema.sql matches the real indexer DDL (column parity)', async function () {
        const { loadSchema, adminQuery } = runtime;
        if (!fs.existsSync(FIXTURE_SCHEMA)) this.skip();
        await loadSchema(FIXTURE_DB, [FIXTURE_SCHEMA]);

        async function columnsByTable(schema) {
            const rows = await adminQuery(
                "SELECT TABLE_NAME t, COLUMN_NAME c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA='" + schema + "'");
            const map = {};
            for (const r of rows) {
                (map[r.t] = map[r.t] || []).push(r.c);
            }
            for (const t in map) map[t].sort();
            return map;
        }
        const real    = await columnsByTable(INDEXER_DB);
        const fixture = await columnsByTable(FIXTURE_DB);

        const drift = [];
        for (const table in fixture) {
            if (!real[table]) {
                drift.push(table + ': in fixture but not in real DDL');
                continue;
            }
            const missing = real[table].filter(c => !fixture[table].includes(c));
            const extra   = fixture[table].filter(c => !real[table].includes(c));
            if (missing.length) drift.push(table + ': fixture missing columns ' + missing.join(', '));
            if (extra.length)   drift.push(table + ': fixture has phantom columns ' + extra.join(', '));
        }
        expect(drift, 'integration fixture drifted from the real indexer DDL:\n' + drift.join('\n'))
            .to.deep.equal([]);
    });
}

module.exports = { registerFixtureParity };
