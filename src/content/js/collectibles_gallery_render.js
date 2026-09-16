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
 * Card renders for collectibles.html (spec explorer-coverage-completion M5.1).
 * Split out of the page so a test can drive the shipped render path against
 * stubbed /api/collectibles payloads.
 *
 * Two rules in here are the product decision, not presentation:
 *
 *  1. CLASSIFICATION IS THE SERVER'S, AND IT IS RE-CHECKED HERE. A collectible
 *     is decimals=0 with a locked max supply, which is exactly isNftToken()'s
 *     rule (formatters.js, mirroring sdk.nft.isNft). getCollectibles binds that
 *     predicate in SQL, so every row arriving here should already satisfy it;
 *     this file asserts it anyway and drops a row that does not. A divisible
 *     token rendered in a gallery of collectibles is a false claim about what
 *     the holder owns, and the cheapest place to refuse it is the last one.
 *
 *  2. SUPPLY IS RENDERED AS A COUNT, NEVER AS AN AMOUNT. These tokens are
 *     indivisible by definition, so "1 of 1" and "37 of 100" are the honest
 *     forms; running them through the divisible amount formatter would print
 *     decimal places that cannot exist. An UNLOCKED mint is called out
 *     separately, because a frozen CEILING is not the same promise as a closed
 *     EDITION and a reader of a gallery will assume the stronger one.
 */

// Page-local escape. Ticks, descriptions and owner addresses are
// attacker-controlled on-chain bytes; nothing below reaches the DOM unescaped.
function collectibleEsc(s){
    return $('<div>').text(s == null ? '' : String(s)).html();
}

// The server's classification, re-checked on the client. Uses the shipped
// isNftToken so there is one rule in the browser, not two.
function collectibleIsClassified(row){
    if(!row) return false;
    return isNftToken(row.decimals, row.lock_max_supply);
}

// "1 of 1" / "37 of 100" / "37" when no ceiling is recorded. Returns null when
// the row carries no readable supply at all, so the caller can omit the line
// rather than print "null of null".
function collectibleEditionLabel(row){
    if(!row) return null;
    let supply = isNull(row.supply) ? null : String(row.supply);
    let max    = isNull(row.max_supply) ? null : String(row.max_supply);
    if(supply === null || !isNumeric(supply)) return null;
    let minted = numeral(supply).format('0,0');
    if(max === null || !isNumeric(max) || Number(max) <= 0) return minted;
    return minted + ' of ' + numeral(max).format('0,0');
}

// One card. `description` is shown as TEXT even when it holds a TIS URL: the
// gallery does not fetch off-chain documents, and rendering a user-supplied URL
// as a link from a list page is an open-redirect surface for no benefit.
function renderCollectibleCard(row){
    let tick  = collectibleEsc(row.tick);
    let icon  = getTokenIcon(row.tick);
    let href  = '/' + XC.coin + '/token/' + encodeURIComponent(String(row.tick));
    let edition = collectibleEditionLabel(row);
    let html = '<div class="col-6 col-md-4 col-lg-3 mb-3 collectible-card" data-tick="' + tick + '">'
             + '<div class="card h-100">'
             + '<a href="' + href + '" class="text-decoration-none">'
             + '<img src="' + collectibleEsc(icon) + '" class="card-img-top collectible-art" alt="' + tick + '"'
             + ' onerror="this.onerror=null;this.src=\'/icon/default.png\';">'
             + '</a>'
             + '<div class="card-body p-2">'
             + '<div class="fw-bold text-truncate"><a href="' + href + '">' + tick + '</a></div>';
    if(edition !== null)
        html += '<div class="small text-muted collectible-edition">' + collectibleEsc(edition) + '</div>';
    // A frozen ceiling with an OPEN mint means more of this edition can still be
    // created. Saying so is the difference between a gallery and a sales pitch.
    if(Number(row.lock_mint) !== 1)
        html += '<div class="small collectible-mint-open"><span class="badge text-bg-secondary">mint open</span></div>';
    if(!isNull(row.description) && String(row.description).length)
        html += '<div class="small text-muted text-truncate collectible-description">'
              + collectibleEsc(row.description) + '</div>';
    if(!isNull(row.owner))
        html += '<div class="small text-muted text-truncate collectible-owner">'
              + formatLink('/' + XC.coin + '/address/' + row.owner, collectibleEsc(row.owner)) + '</div>';
    html += '</div></div></div>';
    return html;
}

// The grid. An empty result is its own explicit state: a chain with no
// collectibles yet is normal, and a blank panel reads as a page that failed.
function renderCollectiblesGallery(rows){
    let list = Array.isArray(rows) ? rows.filter(collectibleIsClassified) : [];
    if(!list.length)
        return '<div class="col-12"><div class="text-muted p-2 collectibles-empty">'
             + 'No collectibles have been issued on this chain yet. A token is listed here when it is'
             + ' issued indivisible (DECIMALS 0) with its maximum supply locked.</div></div>';
    return list.map(renderCollectibleCard).join('');
}

// Prev/next for the gallery. Page numbers rather than a cursor, because
// /api/collectibles pages by ?page= (SQL OFFSET, capped server-side) and the
// gallery has no table cursor to carry.
function renderCollectiblesPager(page, total, limit){
    let p = Math.max(1, Number(page) || 1);
    let l = Math.max(1, Number(limit) || 24);
    let t = Number(total);
    if(!Number.isFinite(t) || t <= 0) return '';
    let pages = Math.max(1, Math.ceil(t / l));
    if(pages <= 1) return '';
    let html = '<nav><ul class="pagination pagination-sm mb-0 collectibles-pager">';
    html += '<li class="page-item' + (p <= 1 ? ' disabled' : '') + '">'
          + '<a class="page-link collectibles-prev" href="#" data-page="' + (p - 1) + '">Previous</a></li>';
    html += '<li class="page-item disabled"><span class="page-link collectibles-position">Page '
          + numeral(p).format('0,0') + ' of ' + numeral(pages).format('0,0') + '</span></li>';
    html += '<li class="page-item' + (p >= pages ? ' disabled' : '') + '">'
          + '<a class="page-link collectibles-next" href="#" data-page="' + (p + 1) + '">Next</a></li>';
    html += '</ul></nav>';
    return html;
}
