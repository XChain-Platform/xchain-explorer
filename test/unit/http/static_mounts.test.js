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
 * Every static mount names a directory that ships.
 *
 * mount.js builds src/content/<dir> from STATIC_DIRECTORIES with a computed
 * segment, which the platform's runtime path-resolution gate cannot judge, so
 * this is the check that a listed directory exists. 'fonts' sat in the list
 * for a year after src/content/fonts was deleted (e1046d3a) and mounted
 * nothing; express.static on a missing directory 404s instead of failing.
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { STATIC_DIRECTORIES } = require('../../../src/http/static_mounts.js');

const CONTENT = path.join(__dirname, '..', '..', '..', 'src', 'content');

describe('static mounts', function(){
    it('lists at least one directory, so the check below cannot pass vacuously', function(){
        assert.ok(Array.isArray(STATIC_DIRECTORIES) && STATIC_DIRECTORIES.length > 0);
    });

    it('names only directories that exist under src/content', function(){
        const missing = STATIC_DIRECTORIES.filter((dir) => {
            try { return !fs.statSync(path.join(CONTENT, dir)).isDirectory(); }
            catch { return true; }
        });
        assert.deepStrictEqual(missing, [], 'mounted but absent under src/content: ' + missing.join(', '));
    });

    it('names each directory once and never reaches outside src/content', function(){
        assert.strictEqual(new Set(STATIC_DIRECTORIES).size, STATIC_DIRECTORIES.length);
        for (const dir of STATIC_DIRECTORIES)
            assert.ok(/^[a-z0-9_-]+$/.test(dir), 'not a plain directory name: ' + dir);
    });
});
