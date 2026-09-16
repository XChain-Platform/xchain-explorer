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
 * Icon downloader SQL
 *
 * Every statement src/icons/downloader.js runs against an indexer DB
 * connection, moved here so SQL text lives under src/db/ only. Each
 * function takes the caller's own `conn` (a per-flavor connection the
 * downloader already holds) and runs exactly the statement that used
 * to sit inline; nothing here opens a connection, starts a transaction
 * or changes what a caller does with the result.
 *
 * SANCTIONED SHARED-WRITE EXCEPTION (#3752): insertMissingIconRows,
 * markDescriptionChangedIcons, restaleActionReferencedIcons, updateIconOk,
 * updateIconFailedTerminal and updateIconFailedRetry write the
 * indexer-owned `icons` table. See the class doc at the top of
 * src/icons/downloader.js for the full boundary rationale; this file is
 * only the statements themselves, marked SHARED-WRITE below so the
 * exception stays auditable at the site that actually issues them.
 *
 ********************************************************************/

'use strict';

// The batch SELECT processFlavor drains: never-checked rows first (newest
// tokens at the front so freshly-minted ones get icons within minutes
// instead of waiting behind the initial-backfill queue), then re-evaluate
// already-checked rows from oldest to newest.
//
// The 'failed' branch is what makes markFailure's backoff live. That
// writer parks a RETRYABLE failure at status='failed' with a
// next_retry_at, and retires a TERMINAL one (attempts >= maxAttempts)
// at status='failed' with next_retry_at NULL. So on a failed row the
// NULL-ness of next_retry_at is the terminal flag, and no other writer
// can forge it: markOk and discover (b) both clear next_retry_at only
// while moving the row off 'failed'. Without this branch the timer
// predicate below is dead for exactly the rows it was written for, and
// one 5s fetch timeout permanently costs an icon on a
// description-locked token - which is the opposite of the contract
// fetchActionFileBytes documents when it throws rather than answering
// "no source".
async function selectIconBatch(conn, batchSize){
    return conn.query(
        `SELECT i.id           AS icon_id,
                        i.token_id     AS token_id,
                        i.attempts     AS attempts,
                        t.description  AS description,
                        idx.tick       AS tick
                 FROM icons i
                 JOIN tokens          t   ON t.id        = i.token_id
                 JOIN index_tickers   idx ON idx.id      = t.tick_id
                 WHERE ( i.status IN ('pending','stale')
                         AND (i.next_retry_at IS NULL OR i.next_retry_at <= NOW()) )
                    OR ( i.status = 'failed'
                         AND i.next_retry_at IS NOT NULL
                         AND i.next_retry_at <= NOW() )
                 ORDER BY i.last_checked_at IS NULL DESC,
                          CASE WHEN i.last_checked_at IS NULL THEN i.token_id END DESC,
                          i.last_checked_at ASC
                 LIMIT ?`,
        [batchSize]
    );
}

// One chunk of the orphan sweep's file-to-row reconciliation: which of these
// on-disk ticks does the DB say have no icon (status='ok', icon_hash NULL)?
// The caller chunks the IN list so it stays inside the statement/packet
// limits on a host whose icon directory has grown large.
async function selectIconTicksInChunk(conn, chunk){
    return conn.query(
        `SELECT idx.tick AS tick
                 FROM icons i
                 JOIN tokens          t   ON t.id   = i.token_id
                 JOIN index_tickers   idx ON idx.id = t.tick_id
                 WHERE i.status = 'ok'
                   AND i.icon_hash IS NULL
                   AND idx.tick IN (${chunk.map(() => '?').join(',')})`,
        chunk
    );
}

// SHARED-WRITE EXCEPTION (#3752): insertMissingIconRows and
// markDescriptionChangedIcons write the indexer-owned `icons` table. This
// is the sanctioned exception to the explorer's read-only boundary and
// requires an INSERT + UPDATE grant on the indexer DB's icons table.
// Tracked post-launch follow-up: move icon-state ownership to the indexer.

// (a) New tokens: INSERT IGNORE on UNIQUE token_id
async function insertMissingIconRows(conn){
    return conn.query(
        `INSERT IGNORE INTO icons (token_id, description_hash, status)
             SELECT t.id, MD5(t.description), 'pending'
             FROM tokens t`
    );
}

// (b) Changed descriptions
async function markDescriptionChangedIcons(conn){
    return conn.query(
        `UPDATE icons i
             JOIN tokens t ON t.id = i.token_id
             SET i.status = 'stale',
                 i.description_hash = MD5(t.description),
                 i.next_retry_at = NULL
             WHERE NOT (MD5(t.description) <=> i.description_hash)`
    );
}

// (c) Re-stale the tokens the resolver gives up on without this branch. Absent
// the `action:` scheme here, an on-chain TIS description resolves to no source
// and is marked ok-with-no-icon, which is TERMINAL: (b) only re-evaluates when
// the description CHANGES, and these descriptions are usually description-locked,
// so the fix would be invisible on every token that already has a row.
//
// The predicate is the RESOLVER'S OWN grammar (ACTION_REF_PATTERN), never a
// prefix test. That is what makes this one-shot rather than a permanent write
// loop on the indexer-owned table: a description merely starting with `action:`
// (`action:foo`, `action:BTC:`, `action:12a`) resolves to NOTHING, so
// processToken marks it ok-with-no-icon again, which is precisely the state this
// statement selects, and a wider predicate would re-stale it on every cycle for as
// long as the token exists - mintable by anyone who can issue a token with such a
// description (#5290). Every description this predicate CAN select resolves to an
// `action` source, and from there the row can only leave with an icon_hash or, on
// any read failure, as 'failed' in the retry backoff; neither state is 'ok' with a
// NULL icon_hash, so neither is re-selectable HERE. The batch SELECT above does
// re-admit such a 'failed' row once its backoff timer elapses, which retries the
// FETCH; because every description this predicate can select resolves, that retry
// ends in an icon_hash or back in the backoff, never in the ok-with-no-icon state
// this statement selects. So after one pass this matches nothing.
//
// CONVERT(... USING binary) is what holds that invariant, and it is not
// decoration. Sharing the pattern text is NOT by itself enough to keep the two
// engines agreeing: the first cut of this statement wrapped the column in LOWER()
// to emulate a JS /i, and LOWER() is not /i. MariaDB's utf8mb4 LOWER() folds
// U+0130 to plain 'i' where JS leaves it alone, so `ACTİON:12` matched HERE and
// resolved to null THERE - selected, unresolvable, re-staled forever, and mintable,
// since descriptions are attacker-controlled on-chain data. Dropping to a binary
// collation removes the engine's case-folding from the comparison entirely, and
// ACTION_REF_PATTERN spells both cases of every letter out, so what matches here is
// the ASCII language and nothing else. Swept on MariaDB 10.11 and 11.4 against a
// real utf8mb4 tokens.description: every Unicode scalar value at each grammar slot,
// zero non-ASCII selections, and every string this does select resolves.
//
// Do NOT reintroduce LOWER(), and do not "simplify" this to a COLLATE clause:
// tokens.description is utf8mb4 in the indexer DDL while the surrounding tables are
// utf8mb3, so a named `COLLATE utf8_bin` is a charset error waiting for whichever
// deployment has the other one. CONVERT-to-binary is charset-agnostic.
//
// Residual slack, both in the SAFE direction (SQL may select a little LESS than the
// resolver accepts, never more): SQL TRIM() strips only spaces where String#trim()
// strips all whitespace, and MariaDB's PCRE `$` also matches before one trailing
// newline, which the resolver's own .trim() removes before it ever matches.
//
// Cost: unlike a `LIKE 'action:%'`, a REGEXP over a wrapped column cannot use an
// index on t.description, but the icons-side conjuncts already reduce this to the
// handful of rows still sitting at ok-with-no-icon, and after the first pass the
// statement updates nothing at all.
// SHARED-WRITE EXCEPTION (#3752): UPDATE on the indexer-owned `icons` table.
//
// ACTION_REF_PATTERN is the resolver's own pattern source text of that name, passed
// in by the caller so this file needs no dependency on the resolver module.
async function restaleActionReferencedIcons(conn, ACTION_REF_PATTERN){
    return conn.query(
        `UPDATE icons i
             JOIN tokens t ON t.id = i.token_id
             SET i.status = 'stale',
                 i.attempts = 0,
                 i.next_retry_at = NULL
             WHERE i.status = 'ok'
               AND i.icon_hash IS NULL
               AND CONVERT(TRIM(t.description) USING binary) REGEXP '${ACTION_REF_PATTERN}'`
    );
}

// SHARED-WRITE EXCEPTION (#3752): UPDATE on the indexer-owned `icons` table.
// Sanctioned write outside the explorer read-only boundary; needs an UPDATE
// grant on the indexer DB. Icon-state ownership relocation is a post-launch follow-up.
async function updateIconOk(conn, sourceUrl, sourceHash, iconHash, descHash, iconId){
    return conn.query(
        `UPDATE icons SET
                 status='ok', attempts=0, last_error=NULL, next_retry_at=NULL,
                 source_url=?, source_hash=?, icon_hash=?, description_hash=?, last_checked_at=NOW()
             WHERE id=?`,
        [sourceUrl, sourceHash, iconHash, descHash, iconId]
    );
}

// SHARED-WRITE EXCEPTION (#3752): UPDATE on the indexer-owned `icons` table.
// Sanctioned write outside the explorer read-only boundary; needs an UPDATE
// grant on the indexer DB. Icon-state ownership relocation is a post-launch follow-up.
async function updateIconFailedTerminal(conn, attempts, errMsg, iconId){
    return conn.query(
        `UPDATE icons SET status='failed', attempts=?, last_error=?,
                                  next_retry_at=NULL, last_checked_at=NOW()
                 WHERE id=?`,
        [attempts, errMsg, iconId]
    );
}

// SHARED-WRITE EXCEPTION (#3752): UPDATE on the indexer-owned `icons` table.
// Sanctioned write outside the explorer read-only boundary; needs an UPDATE
// grant on the indexer DB. Icon-state ownership relocation is a post-launch follow-up.
async function updateIconFailedRetry(conn, attempts, errMsg, sec, iconId){
    return conn.query(
        `UPDATE icons SET status='failed', attempts=?, last_error=?,
                                  next_retry_at=DATE_ADD(NOW(), INTERVAL ? SECOND),
                                  last_checked_at=NOW()
                 WHERE id=?`,
        [attempts, errMsg, sec, iconId]
    );
}

module.exports = {
    selectIconBatch,
    selectIconTicksInChunk,
    insertMissingIconRows,
    markDescriptionChangedIcons,
    restaleActionReferencedIcons,
    updateIconOk,
    updateIconFailedTerminal,
    updateIconFailedRetry,
};
