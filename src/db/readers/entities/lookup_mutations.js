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
 * Resolve valid dispenser mutation parents.
 */

'use strict';

// Keep the method in a class body so the Database surface count still sees it.
class DispenserMutationReaders {
    async getValidDispenserMutationIndex(config, actionType, actionIndex) {
        const tables = {
            DISPENSER_CANCEL: 'dispenser_cancels',
            DISPENSER_EDIT:   'dispenser_edits'
        };
        const table = tables[actionType];
        if (!table) return null;
        let query = `SELECT
                    m.dispenser_action_index
                FROM
                    ${table} m
                    INNER JOIN index_statuses s ON (s.id=m.status_id)
                WHERE
                    m.action_index=? AND
                    s.status='valid'
                LIMIT 1`;
        let results = await this.doQuery(config, query, [actionIndex]);
        if (results && results.length && results[0].dispenser_action_index != null)
            return results[0].dispenser_action_index;
        return null;
    }
}

module.exports = {
    getValidDispenserMutationIndex: DispenserMutationReaders.prototype.getValidDispenserMutationIndex
};
