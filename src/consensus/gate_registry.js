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
 *
 * The explorer's activation registry: every flag-day table the twinned
 * carriers at the top of src/ read, as (key, value) rows keyed
 * '<stem>.<EXPORT>', the spelling the fleet's rules digest and signed GATES
 * field already use. The carriers keep their predicates and read their
 * tables from here, so a table lives in ONE place per repo and a moved
 * carrier can no longer read as "not yet active".
 *
 * This file is the ENTRY. The rows live in the part files under
 * gate_registry/: shared_rows_1.js to shared_rows_5.js are BYTE TWINS of
 * xchain-indexer/src/protocol_changes/shared_rows_1.js to _5.js (the SHARED
 * block every consumer of this platform judges), shared_rows.js is the twin
 * of the queue they write into and regtest_env.js the twin of the arming
 * grammar it reads, and core.js is the consumer core the other consumers copy
 * byte for byte. Copy with cp, prove with cmp: nothing in a twin is edited
 * here, and no key, spelling or order in the block changes inside a window.
 *
 * REGTEST ARMING is applied WHEN A ROW IS READ (shared_rows.js registerRows
 * installs it as the core's read overlay): the block writes the five
 * venue-armed regtest entries UNPINNED, the registry stores that committed
 * table, and every get(), copy(), rows() and activeAt() arms the entry from
 * this process's environment as it stands at that moment. The overlay reads
 * through config.js's `env` (a live read-through view of process.env), never
 * process.env directly, per CODE-STYLE.md's module-shape rule.
 *
 * Readers get(), copy(), has(), keys(), rows() and activeAt(). A miss THROWS a
 * RegistryMissError naming the key: a row a build lacks is a build defect and
 * never a network state. Nothing may add a row after this module loads.
 *
 * EXPLORER-ONLY GATES: ANCHOR_ACTIVATION controls how the browser labels
 * anchors around the DOGE wire restart. It is registered after the shared
 * block from gate_registry/local_rows.js.
 *
 ********************************************************************/

'use strict';

const core = require('./gate_registry/core.js');
const { registerRows } = require('./gate_registry/shared_rows.js');
const { registerLocalRows } = require('./gate_registry/local_rows.js');
const { env } = require('../config.js');

// The SHARED block, loaded for effect: each part queues its rows into
// shared_rows.js as it loads; registerRows() below replays them, in part
// order, into the one registry and installs the venue's regtest arming as
// its read overlay.
require('./gate_registry/shared_rows_1.js');
require('./gate_registry/shared_rows_2.js');
require('./gate_registry/shared_rows_3.js');
require('./gate_registry/shared_rows_4.js');
require('./gate_registry/shared_rows_5.js');

const { registry } = core;
registerRows(registry, env);
registerLocalRows(registry);

module.exports = {
    get: (key) => registry.get(key),
    copy: (key) => registry.copy(key),
    has: (key) => registry.has(key),
    keys: () => registry.keys(),
    rows: () => registry.rows(),
    activeAt: (key, network, coin, height, time) => registry.activeAt(key, network, coin, height, time),
    UNARMED: core.UNARMED,
    UNPINNED: core.UNPINNED,
    RegistryMissError: core.RegistryMissError,
};
