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
 * The per-address dispenser page's wiring.
 *
 * This page shipped for a long time as a pre-XChain scaffold: it fetched
 * nothing from this explorer, its only network call went to an external
 * reputation service, and it displayed HARDCODED sample holdings - a BTC
 * balance and a list of token names - as though they were the address's own.
 * A browser drive against a live dispenser found it rendering "0.12345678 BTC"
 * and "1 RAREPEPE" beside an empty Address row and "Dispenses (0)" for an
 * address that had just taken one.
 *
 * The rebuild loads the SHIPPED dispenser/dispense feeds scoped to the
 * address, so there are exactly two ways for it to regress silently, and this
 * file pins both:
 *
 *   1. Fabricated data comes back. Invented values are the one thing a block
 *      explorer must never render, and they are invisible to a feed test
 *      because no feed produces them.
 *   2. A column is added or trimmed here but not in the sibling list page.
 *      loadDatatablesData's createdRow handlers address cells POSITIONALLY, so
 *      a THEAD that drifts from its sibling misaligns every cell in the row
 *      while the page still loads and still looks plausible.
 */

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const HTML_DIR = path.join(__dirname, '..', '..', '..', '..', 'src', 'content', 'html');
// Composer-aware: dispensers.html and dispenses.html are served by the shared
// list-page composition now, so reading them off disk would fail on absence
// rather than on drift, which is the thing this suite is actually watching.
const SOURCE   = require('../../../helpers/content-source.js');
const read     = (name) => SOURCE.pageSource(name);

// The <thead> cells of the FIRST table carrying the given id.
function headersOf(html, tableId) {
    const table = html.split('id="' + tableId + '"')[1];
    assert.ok(table, 'no table with id ' + tableId);
    const thead = table.split('</thead>')[0];
    return [...thead.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)]
        .map(m => m[1].replace(/<[^>]*>/g, '').trim());
}

describe('dispenser page wiring', () => {

    const dispenser = read('dispenser.html');

    it('renders no fabricated balances, prices or token names', () => {
        // Every string below was live on the page, presented as real data.
        for (const invented of ['0.12345678', '123.43', 'RAREPEPE', 'PEPECASH', 'SHADEPEPE'])
            assert.ok(!dispenser.includes(invented),
                'dispenser.html carries the fabricated sample value ' + invented);
        // The generic form, so a NEW invented token name is caught too.
        assert.ok(!/PEPE[A-Z]/.test(dispenser),
            'dispenser.html carries a hardcoded sample token name');
    });

    it('asks this explorer for its data, not an external service', () => {
        assert.ok(!dispenser.includes('coindaddy.io'),
            'dispenser.html still calls an external service with the viewed address');
        // Both feeds, address-scoped, through the shipped loader.
        assert.ok(dispenser.includes("loadDatatablesData(XC.coin, 'dispenser', XC.query, 'address')"),
            'the dispensers table is not wired to the address-scoped feed');
        assert.ok(dispenser.includes("loadDatatablesData(XC.coin, 'dispense',  XC.query, 'address')"),
            'the dispenses table is not wired to the address-scoped feed');
    });

    it('renders the address it was asked about', () => {
        assert.ok(dispenser.includes("$('#dispenser-address').html(formatLink("),
            'the page does not render its own address');
    });

    it('keeps both tables column-aligned with the list pages they inherit handlers from', () => {
        assert.deepStrictEqual(headersOf(dispenser, 'datatable-dispenser'),
                               headersOf(read('dispensers.html'), 'datatable-dispenser'),
            'the dispensers table has drifted from dispensers.html');
        assert.deepStrictEqual(headersOf(dispenser, 'datatable-dispense'),
                               headersOf(read('dispenses.html'), 'datatable-dispense'),
            'the dispenses table has drifted from dispenses.html');
    });

});

describe('dispenser page modes', () => {

    const dispenser = read('dispenser.html');

    // Runs the page's inline <script> with the page globals stubbed, and reports
    // which feeds and API reads it asked for, and which sections it showed.
    function drive(query) {
        const script = dispenser.split('<script type="text/javascript">\n')[1].split('</script>')[0];
        let ready = null;
        const feeds = [];
        const reads = [];
        const shown = [];
        const hidden = [];
        const el = (sel) => ({
            html() { return this; }, text() { return this; },
            show() { shown.push(sel); return this; }, hide() { hidden.push(sel); return this; },
        });
        const $ = (arg) => (typeof arg === 'object' && arg && arg.nodeType === 9)
            ? { ready: (fn) => { ready = fn; } } : el(arg);
        $.getJSON = (url) => { reads.push(url); return { fail() {} }; };
        const stubs = {
            $, document: { nodeType: 9 },
            XC: { coin: 'TDOGE', query, name: 'Dogecoin', network: 'testnet', pageInfo: {} },
            isNull: (v) => v === null || v === undefined || v === '',
            isNumeric: (v) => /^[0-9]+$/.test(String(v)),
            updatePageInfo() {}, formatLink: () => '', numeral: () => ({ format: () => '' }),
            loadDatatablesData: (coin, action, q, type) => { feeds.push(action + ':' + type); },
            renderDispenserDetail() {}, renderDispenserMessage() {},
        };
        // eslint-disable-next-line no-new-func
        new Function(...Object.keys(stubs), script)(...Object.values(stubs));
        ready();
        return { feeds, reads, shown, hidden };
    }

    it('shows one dispenser for an action_index, reading its DISPENSER action and only its fills', () => {
        // /TDOGE/dispenser/3048 is what every dispenser list row links to.
        const r = drive('3048');
        assert.deepStrictEqual(r.feeds, ['dispense:dispenser']);
        assert.deepStrictEqual(r.reads, ['/TDOGE/api/action/3048']);
        assert.ok(r.shown.includes('#dispenser-index-card'));
        assert.ok(r.hidden.some((s) => s.includes('#dispenser-list-section')));
    });

    it('still shows every dispenser at an address, with both feeds and both counts', () => {
        const addr = 'nqjVHBtKPPMb1TNfmnwx7kZ19G5NzG9rxy';
        const r = drive(addr);
        assert.deepStrictEqual(r.feeds, ['dispenser:address', 'dispense:address']);
        assert.strictEqual(r.reads.length, 2);
        assert.ok(!r.shown.includes('#dispenser-index-card'));
    });

    it('never redirects away from the dispenser page', () => {
        assert.ok(!dispenser.includes('location.replace'), 'dispenser.html still redirects');
    });

});

/*
 * The one-dispenser card's rows, run against the real formatters so escaping
 * and amount formatting are the shipped ones.
 */
describe('dispenser detail rows', () => {
    const vm = require('vm');
    const JS = path.join(__dirname, '..', '..', '..', '..', 'src', 'content', 'js');
    const ctx = vm.createContext({ XC: { coin: 'TDOGE', chain: 'dogecoin', network: 'testnet' }, BigInt });
    for (const f of ['network_coin.js', 'formatters.js', 'dispenser_detail.js'])
        vm.runInContext(fs.readFileSync(path.join(JS, f), 'utf8'), ctx, { filename: f });
    // DISPENSER action 3048 on TDOGE, as /api/action/3048 returns it (trimmed).
    const D3048 = {
        action: 'DISPENSER', action_index: '3048', status: 'valid', block_index: '67933889', timestamp: '1790363081',
        source: 'nmUN3SanVb323ZECB4fVWtrrWoCmxgmVoL', get_address: 'nqjVHBtKPPMb1TNfmnwx7kZ19G5NzG9rxy',
        give_tick: 'S0UR-PATCH-K1DS', give_amount: '1', give_escrow: '85', give_ownership: 0,
        get_coin: 'DOGE', get_tick: null, get_amount: '0.00001985', fiat_amount: null, fiat_code: null,
        oracle_address: null, allow_list: null, block_list: null, expiration: '1798138987',
        state: { give_remaining: '60', expiration: '1798138987', status: 'open' },
    };
    const rows = (d) => Object.fromEntries(vm.runInContext('dispenserDetailRows', ctx)('TDOGE', d));
    it('says what is left: escrow remaining of escrowed, and whole fills that buys', () => {
        const r = rows(D3048);
        assert.match(r['Left in escrow'], /60 S0UR-PATCH-K1DS/);
        assert.match(r['Left in escrow'], /of 85 escrowed/);
        assert.strictEqual(r['Fills remaining'], '60');
        assert.match(r['Status'], />open</);
        assert.match(r['Price per fill'], /0\.00001985 DOGE/);
        assert.match(r['Transaction'], /\/TDOGE\/action\/3048/);
    });
    it('counts fills exactly on decimal amounts', () => {
        const fills = vm.runInContext('dispenserFillsLeft', ctx);
        assert.strictEqual(fills('0.3', '0.1'), '3');
        assert.strictEqual(fills('0.000000000000000003', '0.000000000000000001'), '3');
        assert.strictEqual(fills('5', '2'), '2');
        assert.strictEqual(fills(null, '1'), null);
        assert.strictEqual(fills('5', '0'), null);
    });
    it('prices a fiat dispenser in fiat and names who prices it', () => {
        const r = rows({ ...D3048, get_amount: '0', fiat_amount: '1.50', fiat_code: 'USD', oracle_address: 'nOracle' });
        assert.match(r['Price per fill'], /1\.50 USD/);
        assert.match(r['Price per fill'], /oracle-priced/);
    });
    it('warns when an open fiat dispenser has no usable recent price', () => {
        const r = rows({ ...D3048, fiat_amount: '1.50', fiat_code: 'USD', price_stale: true });
        assert.match(r['Status'], /Not selling: no price in the last 24 hours/);
        assert.match(r['Status'], /cannot settle until its required price sources publish/);
    });
    it('leads with the consensus reason for an invalid dispenser', () => {
        const r = rows({ ...D3048, status: 'invalid: insufficient funds' });
        assert.match(r['Status'], /text-danger/);
        assert.match(r['Status'], /insufficient funds/);
    });
    it('escapes on-chain text bound for the card', () => {
        const r = rows({ ...D3048, fiat_amount: '1', fiat_code: '<img src=x>' });
        assert.ok(!r['Price per fill'].includes('<img'), 'fiat code reached the card unescaped');
    });
    it('renders zero allow/block lists as None without action links', () => {
        const r = rows({ ...D3048, allow_list: 940, block_list: 941,
            state: { ...D3048.state, allow_list: 0, block_list: '0' } });
        assert.strictEqual(r['Allow / block list'], 'None / None');
        assert.ok(!r['Allow / block list'].includes('/action/0'));
    });
});

/*
 * The dispensers list's "view" link opens the dispenser's own page by
 * action_index, which now answers it, rather than the action page.
 */
describe('dispenser list row view link', () => {

    const ROWS = fs.readFileSync(path.join(__dirname, '..', '..', '..', '..',
        'src', 'content', 'js', 'xchain', 'datatable', 'rows_actions_a.js'), 'utf8');

    it('links the view cell to /dispenser/{action_index}', () => {
        const fn = ROWS.split('function xcDatatableRenderDispenserRow(')[1].split('\n}\n')[0];
        assert.ok(fn.includes("'/dispenser/' + action_index"), 'the dispenser row does not link its dispenser page');
    });

});

/*
 * The betting market page's response envelope.
 *
 * /{COIN}/api/bet_feed/{idx} answers with the record FLAT. The page read
 * `o.data`, so `d` was null for every market that has ever existed and the
 * card rendered "Market not found" - directly above its own bets table, which
 * was listing that same market's bets correctly. Driven on a resolved market
 * whose API response carried label, oracle, tick, fee, deadline and a full
 * timeline.
 */
describe('bet feed page response envelope', () => {

    const html = read('bet_feed.html');

    // The shipped expression, evaluated against the shape the endpoint returns.
    function resolve(response) {
        const m = html.match(/let d = \(o && o\.data\)[\s\S]*?: null\);/);
        assert.ok(m, 'the bet_feed response read has moved; update this test');
        // eslint-disable-next-line no-new-func
        return new Function('o', m[0] + ' return d;')(response);
    }

    const FLAT = { action_index: '1290', label: 'm3 tier3 market', feed_status: 'resolved' };

    it('resolves the flat record the endpoint actually returns', () => {
        assert.strictEqual(resolve(FLAT).label, 'm3 tier3 market');
    });

    it('still tolerates an enveloped response', () => {
        assert.strictEqual(resolve({ data: FLAT }).label, 'm3 tier3 market');
        assert.strictEqual(resolve({ data: [FLAT] }).label, 'm3 tier3 market');
    });

    it('still reports a genuinely missing market as not found', () => {
        assert.strictEqual(resolve({}), null);
        assert.strictEqual(resolve(null), null);
        // An error body carries no action_index and must not read as a market.
        assert.strictEqual(resolve({ error: 'not found' }), null);
    });

});
