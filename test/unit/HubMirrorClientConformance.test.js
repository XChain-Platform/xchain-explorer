'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// Drift guard: the explorer's hub-DB mirror client is a byte-identical vendored
// copy of the canonical xchain-indexer implementation (client, schema-version
// lockstep constant, and the six mirror-table SQL twins). Skips when the
// sibling repo isn't present (standalone clone); the cross-repo guard in the
// platform root's bin/ci-all.sh (sync-hub-mirror-client.sh --check) covers the
// monorepo layout regardless.

const fs     = require('fs');
const path   = require('path');
const assert = require('assert');

const LOCAL_SRC  = path.join(__dirname, '../../src');
const CANON_SRC  = path.join(__dirname, '../../../xchain-indexer/src');
const CANON_PRESENT = fs.existsSync(path.join(CANON_SRC, 'hub_db_sync.js'));

const CLIENT_FILES = ['hub_db_sync.js', 'hub-schema-version.js'];
const SQL_FILES = ['price_snapshots.sql', 'oracle_prices.sql', 'cross_chain_matches.sql',
                   'cross_chain_calls.sql', 'capability_snapshots.sql', 'state_checkpoints.sql'];
// Byte-identical consensus twins that are NOT vendored by sync-hub-mirror-client.sh
// (they are hand-maintained in xchain-hub/src, xchain-indexer/src and here). The
// twin's own header claims "the hub-mirror conformance suites compare the consumers",
// so guard the explorer<->indexer pair here; a one-sided edit (comparator/threshold/
// parse-semantics skew) must fail CI before the mainnet activation era, not ship green.
const TWIN_FILES = ['retraction_signing_activation.js'];

describe('hub-mirror client conformance: byte-identity to canonical source @regression', function(){
    before(function(){ if(!CANON_PRESENT) this.skip(); });

    CLIENT_FILES.forEach(function(f){
        it(f + ' is byte-identical to xchain-indexer/src', function(){
            const local = fs.readFileSync(path.join(LOCAL_SRC, f), 'utf8');
            const canon = fs.readFileSync(path.join(CANON_SRC, f), 'utf8');
            assert.strictEqual(local, canon,
                'this repo\'s ' + f + ' has drifted from the canonical source; ' +
                'edit xchain-indexer/src/' + f + ' and run xchain-indexer/bin/sync-hub-mirror-client.sh.');
        });
    });

    TWIN_FILES.forEach(function(f){
        it(f + ' is byte-identical to xchain-indexer/src (hand-maintained twin)', function(){
            const local = fs.readFileSync(path.join(LOCAL_SRC, f), 'utf8');
            const canon = fs.readFileSync(path.join(CANON_SRC, f), 'utf8');
            assert.strictEqual(local, canon,
                'this repo\'s ' + f + ' has drifted from the canonical xchain-indexer copy; ' +
                'this is a hand-maintained triplet twin (hub/indexer/explorer) - keep all three equal.');
        });
    });

    SQL_FILES.forEach(function(f){
        it('sql/hub-mirror/' + f + ' is byte-identical to xchain-indexer/src/sql', function(){
            const local = fs.readFileSync(path.join(LOCAL_SRC, 'sql', 'hub-mirror', f), 'utf8');
            const canon = fs.readFileSync(path.join(CANON_SRC, 'sql', f), 'utf8');
            assert.strictEqual(local, canon,
                'this repo\'s sql/hub-mirror/' + f + ' has drifted from the canonical source; ' +
                'edit xchain-indexer/src/sql/' + f + ' and run xchain-indexer/bin/sync-hub-mirror-client.sh.');
        });
    });
});
