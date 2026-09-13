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

const HTML_DIR = path.join(__dirname, '..', '..', 'src', 'content', 'html');
// Composer-aware: dispensers.html and dispenses.html are served by the shared
// list-page composition now, so reading them off disk would fail on absence
// rather than on drift, which is the thing this suite is actually watching.
const SOURCE   = require('../helpers/content-source.js');
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
