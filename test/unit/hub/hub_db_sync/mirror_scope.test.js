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

const assert = require('assert');
const sinon = require('sinon');
const mirrorScopeMethods = require('../../../../src/hub/hub_db_sync/mirror_scope.js');
const chainIdentityMethods = require('../../../../src/hub/hub_db_sync/chain_identity.js');
const rowApplyMethods = require('../../../../src/hub/hub_db_sync/row_apply.js');
const { getLogger } = require('../../../../src/observability/index.js');
const { REFUSED_ROW_NAME_LIMIT } = require('../../../../src/hub/hub_db_sync/mirror_tables.js');

const TABLE = 'policy_snapshots';

function createSync(options = {}) {
    const columns = options.columns || ['id', 'network'];
    const network = Object.prototype.hasOwnProperty.call(options, 'network')
        ? options.network : 'mainnet';
    const doQuery = options.doQuery || (async () => assert.fail('unexpected database query'));
    const sync = {
        network,
        hubDb: { doQuery },
        _localColumnCache: {
            [TABLE]: {
                cols: new Set(columns),
                types: new Map(),
                fetchedAt: Date.now()
            }
        }
    };

    return Object.assign(sync, mirrorScopeMethods, {
        localColumns: rowApplyMethods.localColumns,
        refusedRowName: chainIdentityMethods.refusedRowName,
        noteRefusedRowName: chainIdentityMethods.noteRefusedRowName,
        nameRefusedRows: chainIdentityMethods.nameRefusedRows
    });
}

describe('mirrorNetworkScope', function () {
    it('returns the declared network when the primed local schema has the column', async function () {
        const sync = createSync();

        assert.strictEqual(await sync.mirrorNetworkScope(TABLE), 'mainnet');
    });

    it('returns null when the consumer has not declared a usable network', async function () {
        for (const network of [undefined, null, '', 12]) {
            const sync = createSync({ network });

            assert.strictEqual(await sync.mirrorNetworkScope(TABLE), null);
        }
    });

    it('returns null when the primed local schema lacks the network column', async function () {
        const sync = createSync({ columns: ['id', 'snapshot_id'] });

        assert.strictEqual(await sync.mirrorNetworkScope(TABLE), null);
    });

    it('returns null when local column discovery fails', async function () {
        const sync = createSync();
        sync.localColumns = async () => { throw new Error('schema unavailable'); };

        assert.strictEqual(await sync.mirrorNetworkScope(TABLE), null);
    });
});

describe('localMaxId', function () {
    it('queries the scoped maximum and converts it to a number', async function () {
        const calls = [];
        const sync = createSync({
            doQuery: async (...args) => {
                calls.push(args);
                return [{ max_id: '27' }];
            }
        });

        assert.strictEqual(await sync.localMaxId(TABLE, 'mainnet'), 27);
        assert.deepStrictEqual(calls, [[
            'SELECT MAX(id) AS max_id FROM policy_snapshots WHERE network = ?',
            ['mainnet']
        ]]);
    });

    it('returns zero for an empty result or a query failure', async function () {
        const empty = createSync({ doQuery: async () => [] });
        const failed = createSync({ doQuery: async () => { throw new Error('missing table'); } });

        assert.strictEqual(await empty.localMaxId(TABLE, null), 0);
        assert.strictEqual(await failed.localMaxId(TABLE, null), 0);
    });
});

describe('foreignNetworkRowNames', function () {
    it('reads bounded natural names and removes empty values', async function () {
        const calls = [];
        const sync = createSync({
            doQuery: async (...args) => {
                calls.push(args);
                return [{ name: 'snapshot-a' }, { name: null }, {}, { name: 9 }];
            }
        });

        assert.deepStrictEqual(await sync.foreignNetworkRowNames(TABLE, 'mainnet'), ['snapshot-a', '9']);
        assert.deepStrictEqual(calls, [[
            'SELECT snapshot_id AS name FROM policy_snapshots WHERE network <> ? ORDER BY id LIMIT '
                + (REFUSED_ROW_NAME_LIMIT * 5),
            ['mainnet']
        ]]);
    });

    it('returns no names when the bounded read fails', async function () {
        const sync = createSync({ doQuery: async () => { throw new Error('read failed'); } });

        assert.deepStrictEqual(await sync.foreignNetworkRowNames(TABLE, 'mainnet'), []);
    });
});

describe('purgeForeignNetworkRows', function () {
    it('deletes foreign rows, names them, and returns the affected count', async function () {
        const sync = createSync({ doQuery: async () => ({ affectedRows: 2 }) });
        const warn = sinon.stub(getLogger(), 'warn');
        sync.foreignNetworkRowNames = async () => ['snapshot-a', 'snapshot-b'];

        try {
            assert.strictEqual(await sync.purgeForeignNetworkRows(TABLE, 'mainnet'), 2);
            assert.match(warn.firstCall.args[0], /snapshot_id snapshot-a, snapshot-b/);
        } finally {
            warn.restore();
        }
    });

    it('returns zero when the delete has no usable affected-row count', async function () {
        const sync = createSync({ doQuery: async () => [] });
        const warn = sinon.stub(getLogger(), 'warn');
        sync.foreignNetworkRowNames = async () => [];

        try {
            assert.strictEqual(await sync.purgeForeignNetworkRows(TABLE, 'mainnet'), 0);
            assert.strictEqual(warn.callCount, 1);
        } finally {
            warn.restore();
        }
    });
});

describe('refuseForeignNetworkRow', function () {
    it('does not refuse unscoped, same-network, or unnamed rows', async function () {
        const undeclared = createSync({ network: null });
        const missingColumn = createSync({ columns: ['id', 'snapshot_id'] });
        const scoped = createSync();

        assert.strictEqual(await undeclared.refuseForeignNetworkRow(TABLE, { network: 'testnet' }), false);
        assert.strictEqual(await missingColumn.refuseForeignNetworkRow(TABLE, { network: 'testnet' }), false);
        assert.strictEqual(await scoped.refuseForeignNetworkRow(TABLE, { network: 'mainnet' }), false);
        assert.strictEqual(await scoped.refuseForeignNetworkRow(TABLE, {}), false);
    });

    it('counts foreign rows and reports no more than the name limit', async function () {
        const sync = createSync();
        const warn = sinon.stub(getLogger(), 'warn');
        const total = REFUSED_ROW_NAME_LIMIT + 2;

        try {
            for (let index = 0; index < total; index += 1) {
                const row = { network: 'testnet', snapshot_id: 'snapshot-' + index };
                assert.strictEqual(await sync.refuseForeignNetworkRow(TABLE, row), true);
            }
            sync.reportRefusedNetworkRows(TABLE);

            const message = warn.firstCall.args[0];
            assert.match(message, new RegExp('refused ' + total));
            assert.match(message, /snapshot-9 and 2 more/);
            assert.doesNotMatch(message, /snapshot-10/);
            assert.strictEqual(sync._refusedNetworkRows.size, 0);
        } finally {
            warn.restore();
        }
    });
});
