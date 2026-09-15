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
 *
 * XChain Explorer - how the request families are installed on the class
 *
 * Every module beside this one carries one family of request handlers, authored
 * as a class body and exporting that class's prototype under `methods`. This
 * file copies those methods onto XChainExplorer.prototype once, at require time,
 * so a handler reads and runs exactly as it did when it sat inline in the class:
 * non-enumerable, writable, configurable, arity intact, `this` the explorer
 * instance at call time.
 *
 * A family that needs one of the entry file's own module bindings (`fs`, `axios`,
 * `dns`, and the lazy config view) declares `useHostBindings` and is handed them
 * here. It must not require them itself: the suites that drive these routes build
 * the explorer through proxyquire, which replaces those modules in
 * XChainExplorer.js's require map only, so a part's own require would resolve the
 * real module and escape the stub.
 *
 ********************************************************************/

'use strict';

const batchReads    = require('./batch.js');
const fileRoutes    = require('./files.js');
const mirrorGate    = require('./mirror_gate.js');
const checkpoints   = require('./proofs.js');
const stateProofs   = require('./state_proofs.js');
const feesPreflight = require('./fees_preflight.js');
const relayEgress   = require('./relay.js');
const paging        = require('./paging.js');
const routeMounts   = require('./mount.js');

// Listed in the order the methods appeared in the class, which is the order they
// install in. It has no effect beyond which family a collision is reported
// against, because every name is distinct.
const FAMILIES = [batchReads, fileRoutes, mirrorGate, checkpoints, stateProofs, feesPreflight, relayEgress, paging, routeMounts];

/**
 * Copy every family's methods onto the explorer prototype.
 *
 * Object.assign cannot do this: a class method is non-enumerable, so assign would
 * copy nothing. Copying the descriptor keeps getters and arity intact.
 *
 * A collision throws rather than resolving by require order, because the loser
 * would vanish silently and the route it answers would start running another
 * family's handler.
 *
 * @param {object} target XChainExplorer.prototype
 * @param {object} hostBindings the entry's own `fs`, `axios`, `dns` and configEnv
 */
function installExplorerFamilies(target, hostBindings){
    for(const family of FAMILIES){
        if(typeof family.useHostBindings === 'function')
            family.useHostBindings(hostBindings);
        const source = family.methods;
        for(const name of Object.getOwnPropertyNames(source)){
            if(name === 'constructor') continue;
            if(Object.prototype.hasOwnProperty.call(target, name))
                throw new Error('explorer family install collision: ' + name + ' is defined twice');
            Object.defineProperty(target, name, Object.getOwnPropertyDescriptor(source, name));
        }
    }
}

module.exports = { installExplorerFamilies };
