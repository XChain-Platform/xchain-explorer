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
 * Factory functions for constructing config objects used by db.js and XChainExplorer.js methods
 */

// Build a standard config object like processRequest creates
function makeConfig(overrides = {}) {
    const base = {
        coin: 'BTC',
        type: 'api',
        file: null,
        data: {
            method: null,
            search: null,
            search2: null,
            search3: null,
            type: null,
            path: '/',
            query: {},
            sql: {
                order: 'DESC',
                limit: 100,
                where: {
                    data: 'm.action_index IS NOT NULL',
                    offset: '',
                    offsetArgs: []
                }
            },
            offset: {
                action: null,
                start: null,
                stop: null
            }
        }
    };

    // Deep merge overrides.data into base.data
    if (overrides.data) {
        const dataOverrides = overrides.data;
        delete overrides.data;
        Object.assign(base, overrides);
        if (dataOverrides.sql) {
            if (dataOverrides.sql.where) {
                Object.assign(base.data.sql.where, dataOverrides.sql.where);
                delete dataOverrides.sql.where;
            }
            Object.assign(base.data.sql, dataOverrides.sql);
            delete dataOverrides.sql;
        }
        if (dataOverrides.offset) {
            Object.assign(base.data.offset, dataOverrides.offset);
            delete dataOverrides.offset;
        }
        if (dataOverrides.query) {
            Object.assign(base.data.query, dataOverrides.query);
            delete dataOverrides.query;
        }
        Object.assign(base.data, dataOverrides);
    } else {
        Object.assign(base, overrides);
    }

    return base;
}

// Build config for a specific action type API request
function makeApiConfig(method, search, type, extras = {}) {
    return makeConfig({
        type: 'api',
        data: {
            method,
            search,
            type,
            query: extras.query || {},
            sql: {
                order: extras.order || 'DESC',
                limit: extras.limit || 100,
                where: {
                    data: extras.whereData || 'm.action_index IS NOT NULL',
                    offset: extras.whereOffset || ''
                }
            }
        }
    });
}

// Build config for an explorer type request
function makeExplorerConfig(method, search, type, extras = {}) {
    return makeConfig({
        type: 'explorer',
        data: {
            method,
            search,
            type,
            query: {
                start: extras.start || 0,
                length: extras.length || 10,
                total: extras.total || null,
                action: extras.action || null,
                offset: extras.offset || null,
                ...extras.query
            },
            sql: {
                order: extras.order || 'DESC',
                limit: extras.limit || 10,
                where: {
                    data: extras.whereData || 'm.action_index IS NOT NULL',
                    offset: extras.whereOffset || ''
                }
            },
            offset: {
                action: extras.action || null,
                start: extras.offsetStart || null,
                stop: extras.offsetStop || null
            }
        }
    });
}

// Build a mock Express request object
function mockReq(path, query = {}) {
    return {
        path: path,
        query: query,
        headers: { host: 'localhost:8080' },
        secure: false
    };
}

// Build a mock Express response object with Sinon-compatible tracking
function mockRes() {
    const res = {
        _status: 200,
        _headers: {},
        _body: null,
        _type: null,
        _redirect: null,
        _sentFile: null,
        status: function(code) { res._status = code; return res; },
        set: function(headers) { Object.assign(res._headers, headers); return res; },
        type: function(t) { res._type = t; return res; },
        send: function(body) { res._body = body; return res; },
        sendFile: function(f) { res._sentFile = f; return res; },
        redirect: function(code, url) { res._redirect = { code, url }; return res; },
        json: function(obj) { res._body = obj; res._type = 'json'; return res; }
    };
    return res;
}

module.exports = {
    makeConfig,
    makeApiConfig,
    makeExplorerConfig,
    mockReq,
    mockRes
};
