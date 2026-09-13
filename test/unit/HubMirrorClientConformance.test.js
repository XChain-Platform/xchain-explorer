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
// lockstep constant, and the mirror-table SQL twins). Skips when the
// sibling repo isn't present (standalone clone); the cross-repo guard in the
// platform root's bin/ci-all.sh (sync-hub-mirror-client.sh --check) covers the
// monorepo layout regardless, but only on a whole-tree sweep: `ci-all.sh --repo
// xchain-explorer` gates that guard on an empty ONLY array and skips it, so this
// file is the sole check on those paths and must not under-enumerate.

const fs     = require('fs');
const path   = require('path');
const assert = require('assert');

const LOCAL_SRC  = path.join(__dirname, '../../src');
const CANON_SRC  = path.join(__dirname, '../../../xchain-indexer/src');
const CANON_PRESENT = fs.existsSync(path.join(CANON_SRC, 'hub', 'hub_db_sync.js'));

const SQL_DIR    = path.join(LOCAL_SRC, 'sql', 'hub-mirror');
const SYNC_SCRIPT = path.join(CANON_SRC, '..', 'bin', 'sync-hub-mirror-client.sh');

// The vendored client set, in two halves because the canonical tree has two depths and
// the copies MUST mirror them. hub_db_sync.js and its lockstep constant live at
// xchain-indexer/src/hub/ and the client reaches its dependency-free modules with `../`,
// so the vendored copies land at src/hub/ here and the dependency modules stay at src/.
// Flattening the client into src/ would resolve those `../` requires one directory above
// this repo's src/ and fail at require on boot. The sync script's HUB_FILES= and
// DEP_FILES= lines are pinned against these lists below, so a module added to one side
// and not the other fails here rather than on boot.
const HUB_FILES = ['hub_db_sync.js', 'hub-schema-version.js'];
const DEP_FILES = ['price_batching_floor_activation.js', 'mirror_admission_activation.js'];

// Enumerate the vendored twins instead of hand-copying their names: a literal list here
// narrows silently against the sync script's shell variable (miss one name, say
// anchor_reward_attestations.sql, and that twin carries no byte-identity assertion at
// all), and a narrowed guard passes. Read errors yield an empty set on purpose, which
// the floor case below turns into a failure: a suite that generates zero cases must not
// read as green.
const SQL_FILES = (function(){
    try {
        return fs.readdirSync(SQL_DIR).filter(function(f){ return f.endsWith('.sql'); }).sort();
    } catch (e) { return []; }
})();

// The floor is the count at the time the enumeration landed. It only ever rises, so a
// new twin needs no edit here, while a mirror directory that was emptied, renamed or
// made unreadable fails instead of silently guarding nothing.
const SQL_FILES_FLOOR = 7;

// The sync script's own list, so the two sides cannot drift apart in EITHER direction:
// a twin the script syncs but nobody vendored, or one vendored after the script stopped
// syncing it, both fail here. Same extraction shape (and same hard failure on an empty
// match) that bin/ci-all.sh already uses against sibling sync scripts.
function scriptFileList(variable){
    const text = fs.readFileSync(SYNC_SCRIPT, 'utf8');
    const m = new RegExp('^' + variable + '="([^"]*)"$', 'm').exec(text);
    assert.ok(m, 'could not read the ' + variable + '= list from ' + SYNC_SCRIPT +
        '; that line is what this guard pins, so an unparseable script is a failure, not a skip.');
    const names = m[1].trim().split(/\s+/).filter(Boolean);
    assert.ok(names.length > 0, variable + '= in ' + SYNC_SCRIPT + ' is empty; nothing would be guarded.');
    return names.sort();
}
function scriptSqlFiles(){ return scriptFileList('SQL_FILES'); }
function scriptHubFiles(){ return scriptFileList('HUB_FILES'); }
function scriptDepFiles(){ return scriptFileList('DEP_FILES'); }
// Byte-identical consensus twins that are NOT vendored by sync-hub-mirror-client.sh
// (they are hand-maintained in xchain-hub/src, xchain-indexer/src and here). The
// twin's own header claims "the hub-mirror conformance suites compare the consumers",
// so guard the explorer<->indexer pair here; a one-sided edit (comparator/threshold/
// parse-semantics skew) must fail CI before the mainnet activation era, not ship green.
const TWIN_FILES = ['retraction_signing_activation.js'];

describe('hub-mirror client conformance: byte-identity to canonical source @regression', function(){
    before(function(){ if(!CANON_PRESENT) this.skip(); });

    [['hub', HUB_FILES], ['', DEP_FILES]].forEach(function(pair){
        const sub = pair[0], names = pair[1];
        const rel = sub ? sub + '/' : '';
        names.forEach(function(f){
            it(rel + f + ' is byte-identical to xchain-indexer/src/' + rel, function(){
                const local = fs.readFileSync(path.join(LOCAL_SRC, sub, f), 'utf8');
                const canon = fs.readFileSync(path.join(CANON_SRC, sub, f), 'utf8');
                assert.strictEqual(local, canon,
                    'this repo\'s src/' + rel + f + ' has drifted from the canonical source; ' +
                    'edit xchain-indexer/src/' + rel + f + ' and run xchain-indexer/bin/sync-hub-mirror-client.sh.');
            });
        });
    });

    it('the HUB_FILES list matches the sync script HUB_FILES list', function(){
        assert.deepStrictEqual([...HUB_FILES].sort(), scriptHubFiles(),
            'this guard and xchain-indexer/bin/sync-hub-mirror-client.sh disagree about which client ' +
            'files are vendored into src/hub/; a module the client requires but the script does not ' +
            'copy fails at require on boot, so keep the two lists one definition.');
    });

    it('the DEP_FILES list matches the sync script DEP_FILES list', function(){
        assert.deepStrictEqual([...DEP_FILES].sort(), scriptDepFiles(),
            'this guard and xchain-indexer/bin/sync-hub-mirror-client.sh disagree about which modules ' +
            'the client reaches with ../; one missing here resolves above this repo\'s src/ and fails ' +
            'at require on boot, so keep the two lists one definition.');
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

    it('the vendored sql/hub-mirror set is enumerable and at or above its floor', function(){
        assert.ok(SQL_FILES.length >= SQL_FILES_FLOOR,
            'expected at least ' + SQL_FILES_FLOOR + ' vendored SQL twins under ' + SQL_DIR +
            ', found ' + SQL_FILES.length + ' (' + SQL_FILES.join(', ') + '); an emptied or ' +
            'renamed mirror directory generates zero byte-identity cases and must fail here.');
    });

    it('the vendored sql/hub-mirror set matches the sync script SQL_FILES list', function(){
        assert.deepStrictEqual(SQL_FILES, scriptSqlFiles(),
            'the vendored sql/hub-mirror directory and xchain-indexer/bin/sync-hub-mirror-client.sh ' +
            'disagree about which SQL twins are vendored; run that script and update its SQL_FILES= line ' +
            'so the vendored set and the sync list stay one definition.');
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
