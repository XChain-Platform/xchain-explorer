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
 * formatters.js
 *
 * The presentation helpers that turn one raw field into the markup a cell
 * shows. They moved out of xchain.js verbatim (spec M2.1) for two reasons.
 *
 * First, the data-table component addresses them BY NAME: a column config says
 * formatter: 'amount' rather than carrying a function, so a theme's column set
 * is data and can live in a JSON file. XCFormatters below is that name table,
 * and it is the only thing a theme has to target.
 *
 * Second, a theme that wants a different amount or link rendering should be
 * able to replace one helper without touching the 5,000-line page controller.
 *
 * Every function is ALSO left on the global scope, exactly as before, because
 * several hundred existing call sites in xchain.js and the per-page render
 * modules call them bare. This file therefore has to load BEFORE xchain.js.
 */

// Determine if value is null or undefined or empty
function isNull(value){
    return (value === null || value === undefined || value==='');
}

// Make a value safe to hand to jQuery's .text(). jQuery (1.10.2, the build this
// app ships) does NOT treat an absent value as "no text": .text(null) stringifies
// it and writes the literal four characters "null" into the element, and
// .text(undefined) is read as the GETTER, so the element silently keeps whatever
// it already held. The /explorer feeds deliver real JS nulls for every column the
// indexer is allowed to leave NULL (a BROADCAST v3 carries no MESSAGE, a LINK
// carries no MEMO, and so on), so those values go through here and render as an
// empty cell, which is what "the action does not carry this field" looks like.
// Note .html() is NOT affected: jQuery empties the element for a null value.
function nullToBlank(value){
    return isNull(value) ? '' : value;
}

// Function to remove HTML content from string
// Escape user-controlled text for safe insertion via jQuery .html() / innerHTML.
// The canonical five-entity replacement. Apply to ANY on-chain free-text field
// (description, memo, message, token names) before it reaches an HTML sink.
// those values are attacker-controlled and the indexer stores them verbatim.
function escapeHtml(s){
    if(s === null || s === undefined) return '';
    return String(s).replace(/[&<>"']/g, function(c){
        return { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c];
    });
}

// Bidi overrides (LRE/RLE/PDF/LRO/RLO, LRI/RLI/FSI/PDI, LRM/RLM), zero-width
// characters (ZWSP/ZWNJ/ZWJ, word joiner, BOM) and C0/C1 controls. The same three
// sets the wallet's textHardening.js and the SDK's decoder/hardening.js carry, and
// the same code points the CONTRACT_META_REQUIRED grammar refuses at consensus.
// The grammar only binds deploys at/after its flag day, so a pre-activation
// contract can hold any of them and every render has to neutralize them itself.
var BIDI_CONTROLS    = /[\u202A-\u202E\u2066-\u2069\u200E\u200F]/g;
var ZERO_WIDTH       = /[\u200B-\u200D\u2060\uFEFF]/g;
var TEXT_CONTROLS    = /[\u0000-\u001F\u007F-\u009F]/g;
var BIDI_PLACEHOLDER = '\u2426'; // SYMBOL FOR SUBSTITUTE FORM TWO

// Neutralize on-chain free text for display. A bidi control becomes a VISIBLE
// placeholder rather than vanishing: silently dropping it would let "evil<RLO>txt"
// read clean, which is the attack. Zero-width characters are dropped, controls
// become a space, and whitespace runs collapse so a stripped control cannot leave
// a fake line break behind. Returns plain text: the caller still escapes it before
// it reaches an HTML sink.
function hardenText(value, maxLength){
    if(isNull(value)) return '';
    var s = String(value)
        .replace(BIDI_CONTROLS, BIDI_PLACEHOLDER)
        .replace(ZERO_WIDTH, '')
        .replace(TEXT_CONTROLS, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    if(typeof maxLength === 'number' && maxLength > 1 && s.length > maxLength)
        s = s.slice(0, maxLength - 1) + '…';
    return s;
}

// A contract's identity label: its declared meta.name plus meta.version, hardened
// and escaped, or the copy for a contract that declares no name (every contract
// deployed before CONTRACT_META_REQUIRED). Never rendered without the address
// beside it (see formatContractIdentity): names are not unique and never will be,
// so the derived address stays the identity.
function formatContractName(metaName, metaVersion){
    var name = hardenText(metaName, 64);
    var ver  = hardenText(metaVersion, 32);
    if(name === '')
        return '<span class="text-muted fst-italic">Unnamed contract</span>';
    // meta.version is free text, so an author who wrote 'v1.0.0' would otherwise
    // render as "vv1.0.0"; the display 'v' is ours, not theirs.
    if(/^[vV][0-9]/.test(ver))
        ver = ver.substring(1);
    return escapeHtml(name) + (ver === '' ? '' : ' <span class="text-muted">v' + escapeHtml(ver) + '</span>');
}

// "Escrow v1.0.0 · C:BTC:2154": the label WITH the derived address, which is the
// only form any surface prints (spec 2.6). chain is the base chain name (XC.chain:
// RBTC -> BTC), matching how the indexer derives C:<CHAIN>:<action_index>.
function formatContractIdentity(coin, chain, contractIndex, metaName, metaVersion){
    // A caller that has not resolved its chain name yet prints the bare index, the
    // way every contract cell did before the manifest: half a derived address
    // ("C::1421") would be a wrong address, and a reader cannot tell that from a
    // right one.
    var address = isNull(chain)
        ? escapeHtml(contractIndex)
        : escapeHtml('C:' + chain + ':' + contractIndex);
    return formatContractName(metaName, metaVersion)
        + ' <span class="text-muted">·</span> '
        + formatLink('/' + coin + '/contract/' + contractIndex, address);
}

function stripHtml(html){
    // Parse INERTLY. DOMParser('text/html') builds a document whose scripts do
    // not run and whose resource handlers (img/onerror, svg/onload) do not fire,
    // so hostile markup can't execute while we pull out plain text. The previous
    // version assigned user input to a live element's .innerHTML, which fires
    // onerror/onload during the assignment, which is itself an XSS execution sink.
    try {
        var doc = new DOMParser().parseFromString(String(html), 'text/html');
        return doc.body.textContent || '';
    } catch(e) {
        // Single-pass tag stripping can leave a tag reassembled from adjacent
        // fragments (e.g. "<scr" + "ipt>"); loop the replace to a fixpoint.
        var out = String(html), prev;
        do {
            prev = out;
            out  = out.replace(/<[^>]*>/g, '');
        } while(out !== prev);
        return out;
    }
}

// Return nice display string for token amount
function formatAmount(amount=null){
    // An absent amount is not a number to format, it is nothing to show. Without
    // this, String(null) is "null", whose length clears the >=4 test, the digit
    // regex matches nothing, and the literal word "null" is returned and rendered
    // into the cell (measured on /RDOGE/issues: Max Supply and Max Mint, both
    // nullable columns, showed "null" on 8 rows each). Guarded on isNull, so 0 is
    // untouched (isNull(0) is false) and '' already returned '' by the old path.
    if(isNull(amount))
        return '';
    var str = String(amount).split('.');
    if(str[0].length>=4)
        str[0] = str[0].replace(/(\d)(?=(\d{3})+$)/g, '$1,');
    return str.join('.');
}

// Return nice display string for token locks. Field order MUST match the
// 7-element pipe-string XChainExplorer.js builds for getIssues/getTokens/
// getProjectTokens rows: max_supply|mint|mint_supply|max_mint|description|
// sleep|callback.
function formatLocks(locks=null){
    var lock = String(locks).split('|'),
        html = '';
    if(lock[0]==1) html += '<i class="fa fa-coins pe-1"         title="Max Supply"></i>';
    if(lock[1]==1) html += '<i class="fa fa-print pe-1"        title="Mint"></i>';
    if(lock[2]==1) html += '<i class="fa fa-bank pe-1"         title="Mint Supply"></i>';
    if(lock[3]==1) html += '<i class="fa fa-coins pe-1"        title="Max Mint"></i>';
    if(lock[4]==1) html += '<i class="fa fa-circle-info pe-1"  title="Description"></i>';
    if(lock[5]==1) html += '<i class="fa fa-bed pe-1"       title="Sleep"></i>';
    if(lock[6]==1) html += '<i class="fa fa-recycle pe-1"      title="Callback"></i>';
    return html;
}

// Canonical NFT-pattern classification (NFT_Standard.md#classification-rule-for-clients):
// a token follows the NFT pattern when DECIMALS=0 AND LOCK_MAX_SUPPLY=1.
// Mirrors sdk.nft.isNft; keep the two in sync.
function isNftToken(decimals, lockMaxSupply){
    return Number(decimals)===0 && Number(lockMaxSupply)===1;
}

// Return path to the token icon
function getTokenIcon(token){
    let icon = '/icon/' + XC.coin + '/' + XC.network + '/' + token + '.png';
    return icon
}

// Handle getting the network icon using the coin name and network
function getNetworkIcon(name=null, network=null){
    // Set defaults for name/network
    if(isNull(name))    name = XC.name;
    if(isNull(network)) network = XC.network;
    let icon = String('fa-xchain-' + name + '-' + network).toLowerCase();
    return icon;
}

// Return nice display string for links
function formatLink(url=null, text=null, icon=false, btn=false){
    var html = '',
        cls  = (btn) ? 'badge bg-success float-end text-decoration-none' : '';
    // A url whose last segment stringified a missing value is not a destination:
    // render the label alone rather than a dead link. ORDER/SWAP/DISPENSER use an
    // empty tick to mean the native coin, which built hrefs ending in /token/null.
    if(/\/(null|undefined)$/.test(String(url)))
        return (text) ? String(text) : '';
        html += '<a href="' + url + '" class="' + cls + '">';
    if(icon && !isNull(icon))
        html += '<img src="' + getTokenIcon(icon) + '" class="icon-20 ms-1 me-1">';
    if(text)
        html += text;
    html += '</a>'
    return html;
}

// Return a truncated hex string (hash / pubkey / request_id) with the full value as
// a hover title, keeping long 64/128-hex identifiers readable in tables.

// Hash-shaped fields are only hex on VALID rows: an INVALID-status ANCHOR persists
// its raw BLOCK_HASH verbatim, and this string reaches jQuery .html(). Escape both
// the truncated body and the title attribute (a no-op on real hex) so a poisoned
// field can never break out of the attribute or inject an element.
function formatHash(hash, len=16){
    if(isNull(hash)) return '';
    let str = String(hash);
    if(str.length <= len) return escapeHtml(str);
    return '<span title="' + escapeHtml(str) + '">' + escapeHtml(str.substring(0, len)) + '…</span>';
}

// Return a nicely formatted amount with token links
function formatLinkAmount(url=null, text=null, icon=false, amount=false){
    let html = '';
    if(!isNull(icon))
        html += formatLink(url, null, icon);
    if(!isNull(amount))
        html += formatAmount(amount);
    if(!isNull(text))
        html += ' ' + formatLink(url, text);
    return html;
}

// Render one leg of a dispenser/order trade: an amount plus whatever it is
// denominated in. A NATIVE-coin leg carries no tick at all (the tick column is
// null), and handing that to formatLinkAmount builds a '/token/null' href -
// formatLink strips such a link now, but the cell would still be labelled with a
// token that does not exist. So an absent tick renders the coin name plainly, and
// a leg carrying neither renders a dash rather than an empty cell.
function formatCoinLegAmount(pageCoin, legCoin, legTick, amount){
    if(isNull(legTick)){
        let txt = isNull(amount) ? '' : formatAmount(amount);
        if(!isNull(legCoin))
            txt += (txt ? ' ' : '') + escapeHtml(String(legCoin));
        return (txt==='') ? '-' : txt;
    }
    let linkCoin = isNull(legCoin) ? pageCoin : legCoin;
    return formatLinkAmount('/' + linkCoin + '/token/' + legTick, legTick, legTick, amount);
}

// Render a DISPENSER / DISPENSE native-coin leg: network icon, amount, coin name.
// Escaped here, not per call site: both are on-chain fields bound for a .html() sink.
// NOT formatCoinLegAmount - that omits the icon and adds thousands separators.
function formatNativeCoinLeg(amount, coin){
    return ' <i class="fa ' + getNetworkIcon() + '"></i> ' + escapeHtml(amount) + ' ' + escapeHtml(coin);
}

// Badge rendered in place of an amount cell when a row represents a
// token-ownership sale (ORDER/SWAP/DISPENSER with GIVE_OWNERSHIP=1 or
// GET_OWNERSHIP=1). The ownership record itself is the asset; there is
// no balance amount to display.
function ownershipBadge(){
    return '<span class="badge bg-warning text-dark" title="Token-ownership transfer">&#128081; Ownership</span>';
}

// Return nice display string for timestamps
function formatLivestamp(timestamp=null){
    var html = '';
    html += '<span data-livestamp='  + timestamp + ' class="nowrap"></span>';
    return html;
}

// The name table the data-table column configs bind to. A name is the stable
// contract; the function behind it is the theme's to replace. Names are short
// because a column config reads better as formatter: 'amount' than as
// formatter: 'formatAmount', and the underlying globals keep their old names so
// no existing call site had to change.
var XCFormatters = {
    amount:       formatAmount,
    locks:        formatLocks,
    link:         formatLink,
    linkAmount:   formatLinkAmount,
    coinLeg:      formatCoinLegAmount,
    nativeCoinLeg: formatNativeCoinLeg,
    hash:         formatHash,
    livestamp:    formatLivestamp,
    tokenIcon:    getTokenIcon,
    networkIcon:  getNetworkIcon,
    ownership:    ownershipBadge,
    escape:       escapeHtml,
    strip:        stripHtml,
    blank:        nullToBlank,
    // Not a formatter but the predicate every formatter branches on; a theme
    // supplying its own cell renderer needs it and should not have to guess
    // that '' counts as absent here.
    isNull:       isNull
};

// Look one up by name. An unknown name is LOUD rather than silently rendering
// nothing: a column config with a typo'd formatter would otherwise produce a
// blank column that reads as missing data.
function xcFormatter(name){
    if(Object.prototype.hasOwnProperty.call(XCFormatters, name))
        return XCFormatters[name];
    if(typeof console !== 'undefined' && console.error)
        console.error('XCFormatters: no formatter named ' + JSON.stringify(name));
    return null;
}

// Node (the unit suites) require this file directly; the browser gets the
// globals above and ignores this block.
if(typeof module !== 'undefined' && module.exports){
    module.exports = {
        XCFormatters: XCFormatters, xcFormatter: xcFormatter,
        isNull: isNull,
        nullToBlank: nullToBlank,
        escapeHtml: escapeHtml,
        hardenText: hardenText,
        formatContractName: formatContractName,
        formatContractIdentity: formatContractIdentity,
        stripHtml: stripHtml,
        formatAmount: formatAmount,
        formatLocks: formatLocks,
        isNftToken: isNftToken,
        getTokenIcon: getTokenIcon,
        getNetworkIcon: getNetworkIcon,
        formatLink: formatLink,
        formatHash: formatHash,
        formatLinkAmount: formatLinkAmount,
        formatCoinLegAmount: formatCoinLegAmount,
        formatNativeCoinLeg: formatNativeCoinLeg,
        ownershipBadge: ownershipBadge,
        formatLivestamp: formatLivestamp
    };
}
