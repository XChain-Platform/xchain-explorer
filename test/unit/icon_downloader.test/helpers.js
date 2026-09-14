'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const sinon      = require('sinon');
const { expect } = require('chai');
const proxyquire = require('proxyquire').noCallThru();
const path       = require('path');

/**
 * Flatten one child_process.execFile call back into the single command string
 * the handlers and assertions in this file match on. IconDownloader spawns via
 * execFile(bin, argv, opts, cb) so there is no shell to escape and Node's
 * timeout signals the binary itself; the argv shape is an implementation
 * detail these tests should not have to spell out element by element.
 */
function execCmdText(call) {
    const argv = Array.isArray(call.args[1]) ? call.args[1] : [];
    return [call.args[0]].concat(argv).join(' ');
}

/**
 * Build a child_process.execFile stub that calls its callback based on the
 * result map: { [cmdSubstring]: result }.  result = null means success with
 * empty stdout/stderr; result = Error means failure; result = {stdout,stderr}
 * means success with those values. The substring is matched against the
 * flattened `bin arg arg ...` text, so the handlers read the same as they did
 * when this spawned through a shell.
 */
function makeExecStub(handlers) {
    // handlers: array of [predicateFn | string, resultOrError]
    return sinon.stub().callsFake(function(file, args, opts, cb) {
        // execFile's callback is the last argument whatever the arity; promisify
        // always passes (file, args, opts, cb), but keep the shorter forms working
        // so a test can call the stub directly.
        if (typeof args === 'function')      { cb = args; args = []; opts = {}; }
        else if (typeof opts === 'function') { cb = opts; opts = {}; }
        const cmd = [file].concat(Array.isArray(args) ? args : []).join(' ');
        for (const [pred, result] of (handlers || [])) {
            const match = typeof pred === 'function' ? pred(cmd) : cmd.includes(pred);
            if (match) {
                if (result instanceof Error) {
                    result.stderr = result.stderr || '';
                    return cb(result);
                }
                return cb(null, result || { stdout: '', stderr: '' });
            }
        }
        // default: success
        cb(null, { stdout: '', stderr: '' });
    });
}


function makeAxiosStub(opts) {
    const axiosStub = {
        get: sinon.stub().resolves({
            status:  200,
            headers: { 'content-type': 'image/png' },
            data:    Buffer.from('PNGDATA'),
        }),
    };
    if (opts.axiosReject) {
        axiosStub.get.rejects(opts.axiosReject);
    } else if (opts.axiosResponse) {
        axiosStub.get.resolves(opts.axiosResponse);
    }
    return axiosStub;
}

function makeFilesystemStubs(opts) {
    // fs stub (sync, barely used by IconDownloader directly)
    const fsStub = {};

    const fspStub = {
        mkdir:     sinon.stub().resolves(),
        writeFile: sinon.stub().resolves(),
        readFile:  sinon.stub().resolves(Buffer.from('PNGOUT')),
        unlink:    sinon.stub().resolves(),
        // The orphan sweep reads the flavor's icon directory. Empty by default, so
        // the sweep short-circuits and every pre-existing processFlavor test keeps
        // its query call-order.
        readdir:   sinon.stub().resolves([]),
    };
    if (opts.fspReaddirResult !== undefined) {
        fspStub.readdir.resolves(opts.fspReaddirResult);
    }
    if (opts.fspReaddirReject) {
        fspStub.readdir.rejects(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    }
    if (opts.fspReadFileResult !== undefined) {
        fspStub.readFile.resolves(opts.fspReadFileResult);
    }
    if (opts.fspWriteFileReject) {
        fspStub.writeFile.rejects(new Error('write failed'));
    }
    if (opts.fspMkdirReject) {
        fspStub.mkdir.rejects(new Error('mkdir failed'));
    }
    return { fsStub, fspStub };
}

function makeImageExecStub(opts) {
    // exec stub (default): sniffMime returns 'image/png', convert succeeds
    const execStub = makeExecStub([
        ['--mime-type', opts.sniffMimeResult !== undefined
            ? (opts.sniffMimeReject ? null : { stdout: opts.sniffMimeResult + '\n', stderr: '' })
            : { stdout: 'image/png\n', stderr: '' }],
        ['-resize',     opts.convertReject  ? new Error('convert failed') : null],
    ]);

    if (opts.sniffMimeReject) {
        // Override to always error on mime sniff
        execStub.callsFake(function(file, args, opts, cb) {
            if (typeof args === 'function')      { cb = args; args = []; }
            else if (typeof opts === 'function') { cb = opts; }
            const cmd = [file].concat(Array.isArray(args) ? args : []).join(' ');
            if (cmd.includes('--mime-type')) {
                cb(new Error('file command failed'));
            } else {
                cb(null, { stdout: '', stderr: '' });
            }
        });
    }
    return execStub;
}

/**
 * Build a fresh set of IO stubs for a test.
 * axiosResult: what axios.get resolves/rejects with
 */
function makeStubs(opts) {
    opts = opts || {};
    const axiosStub = makeAxiosStub(opts);
    const { fsStub, fspStub } = makeFilesystemStubs(opts);
    const execStub = makeImageExecStub(opts);

    // The two resolver entry points are stubbed so a test can dictate what a token's
    // DESCRIPTION resolves to. The resolver has its own suite; what is under test here
    // is what the downloader does with the answer.
    const resolveDescriptionToSource    = opts.resolveDescriptionToSource    || sinon.stub().returns(null);
    const selectIconUrlFromCip25Json    = opts.selectIconUrlFromCip25Json    || sinon.stub().returns(null);

    return { axiosStub, fsStub, fspStub, execStub, resolveDescriptionToSource, selectIconUrlFromCip25Json };
}

// The `action:` grammar is NOT stubbed: it is shared source text that the module
// embeds in the re-stale SQL, and a stubbed copy here would let the SQL and the
// real resolver drift apart without a test noticing - which is the whole failure
// the shared constant exists to prevent.
const { ACTION_REF_PATTERN } = require('../../../src/icons/resolver.js');

/**
 * Load IconDownloader through proxyquire using the provided stubs.
 */
function loadIconDownloader(stubs) {
    return proxyquire('../../../src/icons/downloader.js', {
        'axios':          stubs.axiosStub,
        'fs':             stubs.fsStub,
        'fs/promises':    stubs.fspStub,
        'child_process':  { execFile: stubs.execStub },
        './resolver': {
            resolveDescriptionToSource: stubs.resolveDescriptionToSource,
            selectIconUrlFromCip25Json: stubs.selectIconUrlFromCip25Json,
            ACTION_REF_PATTERN,
        },
    });
}

/**
 * Build a mock DB connection with query/release stubs.
 */
function makeMockConn(queryResults) {
    // queryResults: array of results returned in order, or a single value used always
    let results = Array.isArray(queryResults) ? queryResults.slice() : null;
    const conn = {
        query:   sinon.stub().callsFake(async () => {
            if (results && results.length) return results.shift();
            return [];
        }),
        release: sinon.stub().resolves(),
    };
    return conn;
}

/**
 * Build a mock pool whose getConnection returns `conn`.
 */
function makeMockPool(conn) {
    return { getConnection: sinon.stub().resolves(conn) };
}

/**
 * Build a minimal explorer mock.
 */
function makeExplorer(configOverrides, pools) {
    const cfgBase = Object.assign({
        BTC: {
            mainnet: { database: { indexer: 'xchain_btc' } },
        },
    }, configOverrides || {});

    return {
        util: {},
        configInfo: {
            getConfig: sinon.stub().resolves(cfgBase),
        },
        db: {
            pools: pools !== undefined ? pools : {
                BTC: { pool: makeMockPool(makeMockConn([])) },
            },
        },
    };
}

let clock;

function setClock(nextClock) {
    clock = nextClock;
}

function tickClock(milliseconds) {
    clock.tick(milliseconds);
}

function restoreStubs() {
    if (clock) { clock.restore(); clock = null; }
    sinon.restore();
}

function iconSuite(title, registerTests) {
    describe('IconDownloader', function () {
        afterEach(restoreStubs);
        describe(title, registerTests);
    });
}

module.exports = {
    ACTION_REF_PATTERN,
    expect,
    execCmdText,
    iconSuite,
    loadIconDownloader,
    makeExecStub,
    makeExplorer,
    makeMockConn,
    makeMockPool,
    makeStubs,
    path,
    setClock,
    sinon,
    tickClock,
};
