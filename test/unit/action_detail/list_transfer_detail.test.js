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
 * A LIST format 3 action transfers the list to a new owner, and the indexer
 * records that address in list_transfers. The action detail carries it as
 * `destination` and the LIST card names it, on format 3 only. The current owner
 * under `state` is not a substitute: a later transfer moves it.
 *********************************************************************/

'use strict';

const fs     = require('fs');
const path   = require('path');
const assert = require('assert');
const { JSDOM } = require('jsdom');
const actionDataReaders = require('../../../src/db/readers/action_detail_io/action_data.js');

const config = { coin: 'BTC' };
const util   = { isNull: (value) => value === null || value === undefined };

const CONTENT     = path.resolve(__dirname, '..', '..', '..', 'src', 'content');
const CLIENT_SRC  = require('../../helpers/content-source.js').clientSource();
const JQUERY      = fs.readFileSync(path.join(CONTENT, 'js', 'jquery.min.js'), 'utf8');
const ACTION_HTML = fs.readFileSync(path.join(CONTENT, 'html', 'action.html'), 'utf8');

function missingTable(){
    const driver = new Error("Table 'db.list_transfers' doesn't exist");
    driver.errno = 1146;
    driver.code  = 'ER_NO_SUCH_TABLE';
    const err = new Error('SQL query failed: ' + driver.message);
    err.cause = driver;
    return err;
}

// A reader whose list_transfers read answers `transfer`, or throws it when it is an Error.
function supplementReader(transfer){
    const reader = Object.create(actionDataReaders);
    reader.util = util;
    reader.transferReads = 0;
    reader.doQuery = async (cfg, sql) => {
        if(/list_transfers t\s/.test(sql) && /t\.action_index=\?/.test(sql)){
            reader.transferReads++;
            if(transfer instanceof Error) throw transfer;
            return transfer;
        }
        return [];
    };
    reader.getEmissionProvenanceBatch = async () => new Map();
    return reader;
}

// Run the per-action supplements the detail pipeline runs after the LIST handler.
async function supplement(reader, data){
    await reader.attachActionDetailSupplements(config, 'LIST', 70, data, null);
    return data;
}

describe('LIST format 3 action detail', function(){

    it('carries the transfer destination the indexer recorded', async function(){
        const data = await supplement(supplementReader([{ destination: 'bcNewOwner' }]), { action_format: 3 });
        assert.strictEqual(data.destination, 'bcNewOwner');
    });

    it('reads no transfer row for any other format', async function(){
        const reader = supplementReader([{ destination: 'bcNewOwner' }]);
        const data = await supplement(reader, { action_format: 0 });
        assert.strictEqual(reader.transferReads, 0);
        assert.ok(!('destination' in data));
    });

    it('is null for a transfer with no recorded row', async function(){
        const data = await supplement(supplementReader([]), { action_format: 3 });
        assert.strictEqual(data.destination, null);
    });

    it('is null on a replica without list_transfers, and any other error still throws', async function(){
        const data = await supplement(supplementReader(missingTable()), { action_format: 3 });
        assert.strictEqual(data.destination, null);
        await assert.rejects(supplement(supplementReader(new Error('boom')), { action_format: 3 }), /boom/);
    });
});

function renderList(data){
    const dom = new JSDOM('<!doctype html><html><body>' + ACTION_HTML + '</body></html>', {
        runScripts: 'outside-only', url: 'https://xchain.test/BTC/action/1'
    });
    const win = dom.window;
    win.numeral = function(v){ return { format: function(){ return String(v); } }; };
    win.eval(JQUERY);
    win.jQuery.fn.ready = function(){ return this; };
    win.eval(CLIENT_SRC);
    win.XC = win.XC || {};
    win.XC.coin = 'BTC';
    win.showActionDatatable = function(){};
    win.showListDetails(data);
    return {
        hidden: () => win.jQuery('#info-list .list-destination-row').hasClass('d-none'),
        href: () => win.jQuery('#info-list .list-destination a').attr('href'),
        text: () => win.jQuery('#info-list .list-destination').text()
    };
}

describe('client: the LIST card names a transfer destination', function(){

    it('links the new owner on a format 3 action', function(){
        const card = renderList({ action_format: 3, list_action_index: 41, destination: 'bcNewOwner', list: [], edits: [] });
        assert.strictEqual(card.hidden(), false);
        assert.strictEqual(card.href(), '/BTC/address/bcNewOwner');
    });

    it('shows a dash for a transfer with no recorded destination', function(){
        const card = renderList({ action_format: 3, list_action_index: 41, destination: null, list: [], edits: [] });
        assert.strictEqual(card.hidden(), false);
        assert.strictEqual(card.text(), '-');
    });

    it('hides the row on every other format', function(){
        assert.strictEqual(renderList({ action_format: 0, type: 2, list: [], edits: [] }).hidden(), true);
    });
});
