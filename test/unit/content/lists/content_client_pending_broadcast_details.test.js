/**
 * Transaction page: a pending BROADCAST names its message in the action row.
 *
 * A transaction still in the mempool has no indexed action summary, only the
 * action names and the wire string, so the Details cell must be built from the
 * parsed wire string and the Status cell must read pending. These run the shipped
 * renderer: showTransactionDetails() hands the transaction's actions through
 * pendingTransactionActions() into showActionDatatable().
 */

const fs   = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { expect } = require('chai');
const { srcText } = require('../../../helpers/source_text');
const { extractFn: sliceFunction } = require('../../../helpers/source_slice');

const ROOT    = path.resolve(__dirname, '..', '..', '..', '..');
const SRC     = srcText('src/content/js/xchain.js');
const TX_HTML = fs.readFileSync(path.join(ROOT, 'src/content/html/transaction.html'), 'utf8');
const extractFn = (name) => sliceFunction(SRC, name, 'xchain.js');

function render(tx) {
    const table = TX_HTML.match(/<table[^>]*id="datatable-actions"[\s\S]*?<\/table>/i)[0];
    const dom = new JSDOM('<!DOCTYPE html><body>' + table + '</body>', { runScripts: 'outside-only' });
    const win = dom.window;
    win.eval(fs.readFileSync(path.join(ROOT, 'src/content/js/jquery.min.js'), 'utf8'));
    win.eval(`
        function formatLink(href, text){ return '<a href="' + href + '">' + text + '</a>'; }
        function formatAmount(v){ return String(v); }
        function initStaticDatatable(){ }
        function isNumeric(v){ return v !== null && v !== undefined && v !== '' && !isNaN(Number(v)); }
        function bcmul(a, b, d){ return (Number(a) * Number(b)).toFixed(d); }
    `);
    win.eval(fs.readFileSync(path.join(ROOT, 'src/content/js/formatters.js'), 'utf8'));
    win.XC = { coin: 'TLTC' };
    win.eval(fs.readFileSync(path.join(ROOT, 'src/content/js/xchain/action_detail.js'), 'utf8'));
    win.eval(extractFn('showActionDatatable'));
    // The actions showTransactionDetails() passes to the table: the page's own
    // preparation step when the source has one, else the raw action list.
    let actions = tx.actions;
    if (SRC.includes('function pendingTransactionActions')) {
        win.eval(extractFn('pendingBroadcastSummary'));
        win.eval(extractFn('pendingTransactionActions'));
        actions = win.pendingTransactionActions(tx);
    }
    win.showActionDatatable('actions', actions);
    return win.document.querySelector('#datatable-actions tbody tr');
}

const pendingTx = (data) => ({
    pending: true, tx_data: data, actions: [{ action_index: null, action: 'BROADCAST' }]
});

describe('transaction page: a pending BROADCAST action row', function () {
    it('showTransactionDetails passes the transaction through the pending preparation', function () {
        expect(extractFn('showTransactionDetails')).to.contain("showActionDatatable('actions',pendingTransactionActions(o))");
    });

    it('[REGRESSION] shows the message text of a version 0 broadcast', function () {
        const cells = render(pendingTx('BROADCAST|0|hello world')).querySelectorAll('td');
        expect(cells[3].textContent).to.equal('hello world');
        expect(cells[3].textContent).to.not.contain('undefined');
    });

    it('shows no undefined in the status cell and does not mark the row as failed', function () {
        const row = render(pendingTx('BROADCAST|0|hello world'));
        expect(row.querySelectorAll('td')[4].textContent).to.equal('pending');
        expect(row.className).to.not.contain('bg-red');
    });

    it('reads the oracle and feed versions from their own positions', function () {
        const oracle = render(pendingTx('BROADCAST|1|BTC-USD|84860|0.01|memo')).querySelectorAll('td')[3].textContent;
        expect(oracle).to.contain('Oracle: BTC-USD = 84,860');
        const feed = render(pendingTx('BROADCAST|2|BTC-USD hourly|1|memo')).querySelectorAll('td')[3].textContent;
        expect(feed).to.contain('Feed: BTC-USD hourly');
        const update = render(pendingTx('BROADCAST|3|1234|84860|memo')).querySelectorAll('td')[3].textContent;
        expect(update).to.contain('Result: 84860');
    });

    it('escapes the message', function () {
        const cell = render(pendingTx('BROADCAST|0|<img src=x>')).querySelectorAll('td')[3];
        expect(cell.querySelector('img')).to.equal(null);
        expect(cell.textContent).to.equal('<img src=x>');
    });

    it('falls back to the action name for a wire string it cannot read', function () {
        const cell = render(pendingTx('BROADCAST|9|x')).querySelectorAll('td')[3];
        expect(cell.textContent).to.equal('Broadcast');
    });

    it('leaves a confirmed transaction untouched', function () {
        const tx = { actions: [{ action_index: 7, action: 'BROADCAST', status: 'valid', summary: { action_format: 0, message: 'indexed' } }] };
        const cells = render(tx).querySelectorAll('td');
        expect(cells[3].textContent).to.equal('indexed');
        expect(cells[4].textContent).to.equal('valid');
    });
});
