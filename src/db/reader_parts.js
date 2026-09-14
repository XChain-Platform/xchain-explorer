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
 * XChain Explorer - how reader families are composed into one prototype
 *
 * Every module under src/db/ that carries queries is authored as a class body
 * and exports that class's prototype, and db/index.js copies each of those onto
 * Database.prototype. This file holds the copy, so the same rules apply at both
 * levels of the composition:
 *
 *   - mixinReaders installs a family onto a target (Database.prototype in
 *     db/index.js).
 *   - composeReaderParts folds several part prototypes into ONE fresh object,
 *     for a family too large for one file. The family's entry module exports
 *     that object where it used to export its own prototype, so db/index.js
 *     still receives one prototype-shaped object per family and never learns
 *     how many files it came from.
 *
 * Both go through the same descriptor copy and the same collision check, so a
 * method split into a part installs exactly as it did from the single file:
 * non-enumerable, writable, configurable, arity intact.
 *
 ********************************************************************/

'use strict';

// Copies an extracted reader family onto Database.prototype. Object.assign cannot
// do this: a class method is non-enumerable, so assign would copy nothing. Copying
// the descriptor also keeps getters and arity intact.
//
// A collision throws rather than resolving by require order, because the loser
// would vanish silently and the page it serves would start answering with another
// family's SQL.
function mixinReaders(target, ...sources){
    for(let source of sources){
        for(let name of Object.getOwnPropertyNames(source)){
            if(name=='constructor') continue;
            if(Object.prototype.hasOwnProperty.call(target, name))
                throw new Error('db.js reader mixin collision: ' + name + ' is defined twice');
            Object.defineProperty(target, name, Object.getOwnPropertyDescriptor(source, name));
        }
    }
}

// Folds the prototypes of a split family's part files into one fresh object. The
// object carries no `constructor` of its own, so the only names mixinReaders later
// copies from it are the parts' methods. A name two parts both declare throws here,
// at require time, for the same reason a collision between families does.
function composeReaderParts(...prototypes){
    const composed = {};
    mixinReaders(composed, ...prototypes);
    return composed;
}

module.exports = { mixinReaders, composeReaderParts };
