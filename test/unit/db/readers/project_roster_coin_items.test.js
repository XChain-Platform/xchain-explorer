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
 ********************************************************************/

'use strict';

const { expect } = require('chai');
const projectReaders = require('../../../../src/db/readers/projects.js');

const PROJECT = {
    project: 'PROJECTX',
    link_action_index: 74,
    roster_action_index: 73
};

function compact(sql){
    return String(sql).replace(/\s+/g, ' ').trim();
}

function makeDb({ items, tokens, reverseItem, resolved = false }){
    const db = Object.create(projectReaders);
    db.baseCoin = { BTC: 'BTC' };
    db.util = {
        isNull: value => value === null || value === undefined
    };
    db.calls = [];
    db.isListEditResolutionActiveAtTip = async () => resolved;
    db.getListHeadIndexes = async () => ({ 73: 140 });
    db.getTickId = async (config, tick) => {
        const ids = { FOO: 5 };
        return Object.hasOwn(ids, tick) ? ids[tick] : null;
    };
    db.doQuery = async (config, query, args) => {
        const sql = compact(query);
        db.calls.push({ sql, args: args || [] });
        if(sql.startsWith('SELECT l.action_index AS link_action_index'))
            return [{ link_action_index: 74, roster_action_index: 73 }];
        if(sql.includes('t1.tick AS item_text'))
            return items;
        if(sql.startsWith('SELECT id FROM index_tickers WHERE id IN'))
            return (args || []).filter(id => tokens.some(token => token.id === id)).map(id => ({ id }));
        if(sql.startsWith('SELECT count(*) AS total FROM tokens m'))
            return [{ total: (args || []).filter(id => tokens.some(token => token.id === id)).length }];
        if(sql.startsWith('SELECT t3.tick, m.supply'))
            return tokens.filter(token => (args || []).includes(token.id));
        if(sql.includes('MAX(l.action_index)') && !sql.includes('INNER JOIN list_items'))
            return [PROJECT];
        if(sql.includes('MAX(l.action_index)') && sql.includes('INNER JOIN list_items')){
            const matches = (args || []).slice(2);
            const found = matches.some(value => String(value).toLowerCase() === String(reverseItem).toLowerCase());
            return found ? [PROJECT] : [];
        }
        if(sql.startsWith('SELECT li.action_index FROM list_items li')){
            const matches = (args || []).slice(0, 3);
            const found = matches.some(value => String(value).toLowerCase() === String(reverseItem).toLowerCase());
            return found ? [{ action_index: 140 }] : [];
        }
        return [];
    };
    return db;
}

function projectConfig(){
    return { coin: 'BTC', data: { search: 'PROJECTX' } };
}

function rosterConfig(){
    return {
        coin: 'BTC',
        data: {
            search: 'PROJECTX',
            sql: { where: { data: 'm.action_index IS NOT NULL', offset: '' }, order: 'ASC', limit: 100 }
        }
    };
}

describe('project roster coin-qualified items', function () {

    it('lists only this chain tokens from a mirror roster and counts only token rows', async function () {
        const db = makeDb({
            items: [
                { item_id: 101, item_text: 'btc:FOO' },
                { item_id: 102, item_text: 'BTC:^7' },
                { item_id: 103, item_text: 'DOGE:PEPE' }
            ],
            tokens: [
                { id: 5, tick: 'FOO', supply: '10', max_supply: '10', decimals: 0, lock_max_supply: 1 },
                { id: 7, tick: 'SEVEN', supply: '7', max_supply: '7', decimals: 0, lock_max_supply: 1 }
            ],
            reverseItem: 'BTC:FOO'
        });

        const [project] = await db.getProject(projectConfig());
        expect(project.members.map(member => member.tick)).to.deep.equal(['FOO', 'SEVEN']);
        expect(project.members.map(member => member.tick)).to.not.include('PEPE');
        expect(project.total).to.equal(2);

        const memberRead = db.calls.find(call => call.sql.startsWith('SELECT t3.tick, m.supply'));
        expect(memberRead.args).to.deep.equal([5, 7, 103]);
        expect(memberRead.sql).to.include('m.tick_id IN (?,?,?)');
        expect(memberRead.sql).to.not.include('list_items');
        const idResolution = db.calls.find(call => call.sql.startsWith('SELECT id FROM index_tickers WHERE id IN'));
        expect(idResolution.sql).to.include('block_index IS NOT NULL');

        const [query, args, count] = await db.getProjectTokens(rosterConfig());
        expect(args).to.deep.equal([5, 7, 103]);
        expect(query).to.include('m.tick_id IN (?,?,?)');
        expect(count).to.include('m.tick_id IN (?,?,?)');
        expect(query).to.not.include('list_items');
        expect(count).to.not.include('list_items');
    });

    it('finds a project through a case-folded own-chain name in both roster paths', async function () {
        for(const [resolved, membership] of [[false, 73], [true, 140]]){
            const db = makeDb({ items: [], tokens: [], reverseItem: 'BTC:FOO', resolved });
            const projects = await db.getTokenProjects({ coin: 'BTC' }, 'FOO');
            expect(projects).to.deep.equal([{
                project: 'PROJECTX',
                link_action_index: 74,
                roster_action_index: 73,
                membership_action_index: membership
            }]);
            const matchCall = db.calls.find(entry => entry.sql.includes('LOWER(t2.tick)=LOWER(?)'));
            expect(matchCall.args.slice(0, 5)).to.deep.equal(resolved
                ? ['FOO', 'BTC:FOO', 'BTC:^5', 140]
                : ['BTC', 'BTC', 'FOO', 'BTC:FOO', 'BTC:^5']);
        }
    });

    it('keeps bare roster items on the legacy token id path', async function () {
        const db = makeDb({
            items: [{ item_id: 5, item_text: 'FOO' }],
            tokens: [{ id: 5, tick: 'FOO', supply: '10', max_supply: '10', decimals: 0, lock_max_supply: 1 }],
            reverseItem: 'FOO'
        });
        const [project] = await db.getProject(projectConfig());
        expect(project.total).to.equal(1);
        expect(project.members.map(member => member.tick)).to.deep.equal(['FOO']);
        const memberRead = db.calls.find(call => call.sql.startsWith('SELECT t3.tick, m.supply'));
        expect(memberRead.args).to.deep.equal([5]);

        const projects = await db.getTokenProjects({ coin: 'BTC' }, 'FOO');
        expect(projects.map(row => row.project)).to.deep.equal(['PROJECTX']);
    });

    it('uses an impossible predicate when no own-chain item resolves', async function () {
        const db = makeDb({
            items: [{ item_id: 101, item_text: 'BTC:^999' }],
            tokens: [],
            reverseItem: null
        });
        const [project] = await db.getProject(projectConfig());
        expect(project.total).to.equal(0);
        expect(project.members).to.deep.equal([]);
        const memberRead = db.calls.find(call => call.sql.startsWith('SELECT t3.tick, m.supply'));
        expect(memberRead.sql).to.include('WHERE 1=0');

        const [query, args, count] = await db.getProjectTokens(rosterConfig());
        expect(args).to.deep.equal([]);
        expect(query).to.include('WHERE 1=0');
        expect(count).to.include('WHERE 1=0');
    });
});
