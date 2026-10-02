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
 ********************************************************************/

'use strict';

const assert = require('assert');
const listReaders = require('../../../src/db/readers/action_detail_io/lists.js');

const config = { coin: 'DOGE' };

function makeReader(roots, result){
    const reader = Object.create(listReaders);
    reader.calls = [];
    reader.getListRootIndexes = async (cfg, indexes) => {
        reader.rootCall = { cfg, indexes };
        return roots;
    };
    reader.doQuery = async (cfg, sql, args) => {
        reader.calls.push({ cfg, sql: String(sql), args });
        if(result instanceof Error) throw result;
        return result;
    };
    return reader;
}

describe('LIST metadata values', function () {
    it('returns the newest valid metadata for a named root', async function () {
        const reader = makeReader({ '41': 41 }, [
            { root: 41, action_index: 41, name: 'Validators', description: 'Approved operators' }
        ]);

        assert.deepStrictEqual(await reader.getListMetas(config, [41]), {
            '41': { name: 'Validators', description: 'Approved operators' }
        });
    });

    it("returns a root's metadata under an edit index", async function () {
        const reader = makeReader({ '44': 41 }, [
            { root: 41, action_index: 41, name: 'Validators', description: null }
        ]);

        assert.deepStrictEqual(await reader.getListMetas(config, [44]), {
            '44': { name: 'Validators', description: null }
        });
        assert.deepStrictEqual(reader.rootCall, { cfg: config, indexes: [44] });
    });

    it('lets the higher action_index row win for one root', async function () {
        const reader = makeReader({ '41': 41 }, [
            { root: 41, action_index: 41, name: 'Old name', description: 'Old description' },
            { root: 41, action_index: 58, name: 'New name', description: 'New description' }
        ]);

        assert.deepStrictEqual(await reader.getListMetas(config, [41]), {
            '41': { name: 'New name', description: 'New description' }
        });
    });
});

describe('LIST metadata fallbacks and query', function () {
    it('returns null fields for a root with no metadata row', async function () {
        const reader = makeReader({ '41': 41, '90': 90 }, [
            { root: 41, action_index: 41, name: 'Named', description: null }
        ]);

        assert.deepStrictEqual(await reader.getListMetas(config, [41, 90]), {
            '41': { name: 'Named', description: null },
            '90': { name: null, description: null }
        });
    });

    it('returns null fields when list_metas is missing', async function () {
        const error = Object.assign(new Error('missing table'), { code: 'ER_NO_SUCH_TABLE' });
        const reader = makeReader({ '41': 41 }, error);

        assert.deepStrictEqual(await reader.getListMetas(config, [41]), {
            '41': { name: null, description: null }
        });
    });

    it('rethrows query errors unrelated to a missing table', async function () {
        const error = Object.assign(new Error('connection failed'), { code: 'ECONNRESET' });
        const reader = makeReader({ '41': 41 }, error);

        await assert.rejects(reader.getListMetas(config, [41]), err => err === error);
    });

    it('queries valid list_metas rows in ascending action order', async function () {
        const reader = makeReader({ '41': 41, '90': 90 }, []);
        await reader.getListMetas(config, [41, 90]);

        assert.strictEqual(reader.calls.length, 1);
        assert.match(reader.calls[0].sql, /FROM\s+list_metas m/);
        assert.match(reader.calls[0].sql, /INNER JOIN index_statuses s ON \(s\.id=m\.status_id\)/);
        assert.match(reader.calls[0].sql, /s\.status='valid'/);
        assert.match(reader.calls[0].sql, /ORDER BY m\.action_index ASC/);
        assert.deepStrictEqual(reader.calls[0].args, [41, 90]);
    });
});
