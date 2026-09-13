/**
 * Transaction page: the empty-result path and the hash/index dispatch.
 *
 * Three defects, all on the path a user hits immediately after broadcasting,
 * while their transaction is still unconfirmed:
 *
 *   1. showActionDatatable() left the static "Loading action data..." placeholder
 *      row in the tbody when the result set was empty, then initialised DataTables
 *      over it. DataTables adopts existing rows and expects one <td> per <th>; it
 *      does NOT expand colspan. It found one cell where the header declares six,
 *      dereferenced the missing ones, and threw
 *      "Cannot set properties of undefined (setting '_DT_CellIndex')".
 *
 *   2. transaction.html's placeholder declared colspan="4" against a six-column
 *      header, which is what made this table the one that broke. Fixing only the
 *      colspan would still leave a stale "Loading..." row where "No records found"
 *      belongs, so both halves are needed and both are pinned here.
 *
 *   3. The transaction route disambiguated hash from index with isNumeric(), which
 *      is true for any run of decimal digits and never checks length. A 64-hex
 *      transaction hash whose characters all happen to be 0-9 was therefore read
 *      as a transaction INDEX, and the page rendered a real, unrelated transaction
 *      under the URL of a hash that does not exist.
 *
 * These run the SHIPPED source (sliced out of xchain.js, and the real markup read
 * off disk) rather than copies, so the tests fail if the fix is reverted or drifts.
 */

const fs   = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { expect } = require('chai');

const ROOT     = path.resolve(__dirname, '../..');
const SRC      = fs.readFileSync(path.join(ROOT, 'src/content/js/xchain.js'), 'utf8');
const EXPLORER = fs.readFileSync(path.join(ROOT, 'src/XChainExplorer.js'), 'utf8');
const TX_HTML  = fs.readFileSync(path.join(ROOT, 'src/content/html/transaction.html'), 'utf8');

// Slice a shipped function out of xchain.js by walking braces, the same technique
// the sibling content-client tests use.
function extractFn(name) {
    const sig = 'function ' + name + '(';
    const start = SRC.indexOf(sig);
    if (start < 0) throw new Error('function not found in xchain.js: ' + name);
    const braceStart = SRC.indexOf('{', start);
    let depth = 0, i = braceStart;
    for (; i < SRC.length; i++) {
        const c = SRC[i];
        if (c === '{') depth++;
        else if (c === '}') { depth--; if (depth === 0) { i++; break; } }
    }
    return SRC.slice(start, i);
}

// The actions table exactly as transaction.html ships it, header and placeholder
// both taken from the real file so a future markup edit is caught here.
function actionsTableMarkup() {
    const m = TX_HTML.match(/<table[^>]*id="datatable-actions"[\s\S]*?<\/table>/i);
    if (!m) throw new Error('could not locate #datatable-actions in transaction.html');
    return m[0];
}

describe('transaction page: an empty action list renders instead of throwing', function () {

    it('[REGRESSION] showActionDatatable clears the placeholder row when there are no actions', function () {
        const dom = new JSDOM('<!DOCTYPE html><body>' + actionsTableMarkup() + '</body>',
            { runScripts: 'outside-only' });
        dom.window.eval(fs.readFileSync(path.join(ROOT, 'src/content/js/jquery.min.js'), 'utf8'));
        dom.window.eval('function initStaticDatatable(){ }');
        dom.window.XC = { coin: 'BTC' };
        dom.window.eval(extractFn('showActionDatatable'));

        // The placeholder is present before the call, exactly as the page ships.
        expect(dom.window.document.querySelectorAll('#datatable-actions tbody tr')).to.have.length(1);
        expect(dom.window.document.querySelector('#datatable-actions tbody').textContent)
            .to.contain('Loading action data');

        dom.window.showActionDatatable('actions', []);

        // Empty path must leave DataTables an EMPTY tbody to draw zeroRecords into.
        const rows = dom.window.document.querySelectorAll('#datatable-actions tbody tr');
        expect(rows, 'the stale placeholder row must be cleared on the empty path').to.have.length(0);
    });

    it('a non-empty action list still renders its rows', function () {
        const dom = new JSDOM('<!DOCTYPE html><body>' + actionsTableMarkup() + '</body>',
            { runScripts: 'outside-only' });
        dom.window.eval(fs.readFileSync(path.join(ROOT, 'src/content/js/jquery.min.js'), 'utf8'));
        dom.window.eval(`
            function formatLink(href, text){ return '<a href="' + href + '">' + text + '</a>'; }
            function formatAmount(v){ return String(v); }
            function getActionDetails(){ return 'summary'; }
            function initStaticDatatable(){ }
        `);
        dom.window.XC = { coin: 'BTC' };
        dom.window.eval(extractFn('showActionDatatable'));

        dom.window.showActionDatatable('actions', [
            { action_index: 42, action: 'SEND', status: 'valid', summary: { x: 1 } }
        ]);

        const rows = dom.window.document.querySelectorAll('#datatable-actions tbody tr');
        expect(rows).to.have.length(1);
        expect(rows[0].querySelectorAll('td')).to.have.length(6);
    });

    it('[REGRESSION] the placeholder colspan matches the header column count', function () {
        const table = actionsTableMarkup();
        const headerCols = (table.match(/<th[\s>]/g) || []).length;
        const colspan = Number((table.match(/<td[^>]*colspan="(\d+)"/i) || [])[1]);

        expect(headerCols, 'the actions table header should declare six columns').to.equal(6);
        expect(colspan,
            'DataTables does not expand colspan when adopting existing rows, so a ' +
            'placeholder narrower than the header throws _DT_CellIndex')
            .to.equal(headerCols);
    });
});

describe('transaction route: a 64-hex hash is never mistaken for a transaction index', function () {

    // Drive the shipped dispatch by pointing a jsdom window at a transaction URL.
    function resolveType(query) {
        const dom = new JSDOM('<!DOCTYPE html><body></body>',
            { url: 'https://explorer.xchain.io/BTC/transaction/' + query, runScripts: 'outside-only' });
        dom.window.eval(`
            function stripHtml(s){ return s; }
            function isNull(v){ return v === null || v === undefined || v === ''; }
            function isNumeric(v){ return /^[0-9]+$/.test(String(v)); }
            function isCryptoAddress(){ return false; }
            function getXChainParam(coin, key){
                if(key === 'coin') return 'BTC';
                return key;
            }
            var XC = {};
        `);
        dom.window.eval(extractFn('setXChainParams'));
        dom.window.setXChainParams('BTC');
        return dom.window.XC.type;
    }

    it('[REGRESSION] an all-decimal 64-character hash resolves as a hash, not an index', function () {
        const allDigits = '0'.repeat(63) + '1';
        expect(allDigits).to.have.length(64);
        expect(resolveType(allDigits),
            'a 64-char query is a transaction hash even when every character is a digit; ' +
            'treating it as an index renders an unrelated transaction under a hash URL')
            .to.equal('tx_hash');
    });

    it('an ordinary hex hash still resolves as a hash', function () {
        expect(resolveType('8b14b2b0a75d83c8516625983c3a53f8b51197ef0c707a916df3e736d76f1d32'))
            .to.equal('tx_hash');
    });

    it('a short numeric query still resolves as a transaction index', function () {
        expect(resolveType('1')).to.equal('tx_index');
        expect(resolveType('149703')).to.equal('tx_index');
    });
});

describe('transaction route: /{COIN}/tx/{QUERY} is aliased to the canonical /transaction/ URL', function () {

    it('the alias is registered and redirects permanently rather than serving a second copy', function () {
        const m = EXPLORER.match(/this\.app\.get\('\/:coin\/tx\/:query'[\s\S]{0,400}?\}\);/);
        expect(m, '/:coin/tx/:query must be registered in src/XChainExplorer.js').to.not.equal(null);
        expect(m[0], 'the alias must 301 so a transaction keeps ONE canonical URL')
            .to.contain('redirect(301');
        expect(m[0], 'the alias must point at the canonical /transaction/ path')
            .to.contain("'/transaction/'");
    });

    it('the alias carries the querystring across', function () {
        const m = EXPLORER.match(/this\.app\.get\('\/:coin\/tx\/:query'[\s\S]{0,600}?\n        \}\);/);
        expect(m, '/:coin/tx/:query must be registered').to.not.equal(null);
        // setXChainParams() resolves the coin from ?coin=, so a redirect that drops the
        // querystring silently sends the reader to a different chain's transaction.
        expect(m[0], 'the redirect must preserve the querystring')
            .to.contain('originalUrl');
    });
});
