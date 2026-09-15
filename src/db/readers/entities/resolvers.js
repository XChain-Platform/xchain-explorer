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
 * XChain Explorer - the id-resolution lookups
 *
 * One part of src/db/readers/entities.js (the entry composes it through
 * composeReaderParts). The reads that turn a string a URL carries into the
 * row id the rest of the schema joins on: an address to its addresses row,
 * a tick to its tokens row, plus the two narrower address forms (exact-only
 * and compactable) callers reach for when a near miss would be wrong.
 *
 * They are one part because every other part calls them and none of them
 * calls anything else: filing them under a caller would have picked one of
 * several callers arbitrarily.
 *
 * Authored as a class body whose prototype is exported, like every other
 * family under src/db/: `this` is the Database instance at call time, and the
 * methods reach Database.prototype non-enumerable, by descriptor.
 *
 ********************************************************************/

'use strict';

class EntityResolverReaders {
    async getAddressId(config, address){
        let key    = this.cacheKey(config.coin, address);
        let cached = this.cacheGet(this._addressIdCache, key);
        if(cached !== undefined) return cached;
        let id    = null;
        let args  = [address];
        let query = `SELECT
                        id
                    FROM
                        index_addresses
                    WHERE
                        address=?
                    LIMIT 1`
        let results = await this.doQuery(config, query, args);
        if(results && results.length)
            id = results[0].id;
        if(id !== null) this.cacheSet(this._addressIdCache, key, id);
        return id;
    }

    // Address -> index id resolved BYTE-EXACTLY. Used by the MATCHING paths only:
    // getMempool TYPE=address and the Broadcaster's mempool fan-out memo.
    //
    // index_addresses is CHARSET=utf8 COLLATE=utf8_general_ci, so the plain
    // `address=?` in getAddressId matches every case variant of an address and
    // hands back the id of a DIFFERENT address. Display and search paths want that
    // (a human typing an address by hand reaches the page they meant). A matcher
    // must not have it: a `^<id>` destination on the wire is an exact reference, so
    // a case variant resolved through the ci lookup makes an unrelated address a
    // party to the transaction, and a wallet shows somebody else's pending payment
    // as its own. Base58 is case-SENSITIVE; a case variant is a different string,
    // not the same address typed loosely.
    //
    // BECH32, deliberately not handled here: BIP173 addresses are case-INSENSITIVE
    // with a lowercase canonical form, so an uppercase bech32 spelling resolves to
    // null through this lookup and its compacted destinations go unmatched (literal
    // segments still match, and the sender still matches). Canonicalizing an
    // address before lookup is address-normalization work that belongs to the row
    // that owns it, not to this matcher.
    //
    // The equality is written twice on purpose. `address=?` runs in the table's own
    // collation and is the index seek (index_addresses has a UNIQUE index on
    // address, so under a ci collation it returns at most one row for all case
    // variants); the utf8_bin comparison is the byte-exact gate over that one row.
    // Collating the column alone in the seek predicate would force a full scan.
    // Cached like getAddressId, non-null results only, in its own LRU.
    async getExactAddressId(config, address){
        let key    = this.cacheKey(config.coin, address);
        let cached = this.cacheGet(this._exactAddressIdCache, key);
        if(cached !== undefined) return cached;
        let id    = null;
        let args  = [address, address];
        let query = `SELECT
                        id
                    FROM
                        index_addresses
                    WHERE
                        address=? AND address COLLATE utf8_bin = ?
                    LIMIT 1`
        let results = await this.doQuery(config, query, args);
        if(results && results.length)
            id = results[0].id;
        if(id !== null) this.cacheSet(this._exactAddressIdCache, key, id);
        return id;
    }

    // Resolve an address to its index id ONLY when that id is in the DETERMINISTIC set
    // (assigned inside a block tx, block_index IS NOT NULL) - the id-space a wire ^<id>
    // may safely reference. Backs the SDK-facing info.address_id in getAddress (F3
    // id-determinism). Distinct from getAddressId, which resolves ANY id (incl. out-of-band
    // recovery pre-seeds) for internal string<->id display/lookup paths that must not change.
    // Uncached: one call per getAddress request, and a NULL-block id must never be cached as
    // compactable (it could be upgraded to a deterministic id on a later reindex).
    async getCompactableAddressId(config, address){
        let query = `SELECT
                        id
                    FROM
                        index_addresses
                    WHERE
                        address=? AND block_index IS NOT NULL
                    LIMIT 1`;
        let results = await this.doQuery(config, query, [address]);
        return (results && results.length) ? results[0].id : null;
    }

    async getTickId(config, tick){
        // A `^<id>` reference resolves directly to the numeric id, no lookup
        // needed. Everything after the caret is the id (do not drop any digit).
        let str = String(tick);
        if(str.charAt(0) === '^' && this.util.isNumeric(str.substring(1)))
            return Number(str.substring(1));
        let key    = this.cacheKey(config.coin, tick);
        let cached = this.cacheGet(this._tickIdCache, key);
        if(cached !== undefined) return cached;
        let id    = null;
        let args  = [tick];
        let query = `SELECT
                        id
                    FROM
                        index_tickers
                    WHERE
                        tick=?
                    LIMIT 1`
        let results = await this.doQuery(config, query, args);
        if(results && results.length)
            id = results[0].id;
        if(id !== null) this.cacheSet(this._tickIdCache, key, id);
        return id;
    }
}

module.exports = EntityResolverReaders.prototype;
