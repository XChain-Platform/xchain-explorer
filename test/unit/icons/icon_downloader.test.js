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

const {
    ACTION_REF_PATTERN, expect, execCmdText, iconSuite, loadIconDownloader,
    makeExecStub, makeExplorer, makeMockConn, makeMockPool, makeStubs, path,
    setClock, sinon, tickClock,
} = require('./icon_downloader.test/support/helpers.js');


{

    iconSuite('constructor', function () {
        it('initialises with DEFAULTS and correct iconRoot', function () {
            const stubs = makeStubs();
            const IconDownloader = loadIconDownloader(stubs);
            const explorer = makeExplorer();
            const d = new IconDownloader(explorer);

            expect(d.cfg.enabled).to.equal(false);
            expect(d.cfg.intervalMinutes).to.equal(15);
            expect(d.cfg.batchSize).to.equal(50);
            expect(d.cfg.maxAttempts).to.equal(4);
            expect(d.cfg.recursionLimit).to.equal(2);
            expect(d._running).to.equal(false);
            expect(d._stop).to.equal(false);
            expect(d.timer).to.equal(null);
            expect(d.iconRoot).to.include('content/icons');
            // The write root is joined from the module's own directory, so a
            // relative segment that stops matching the file's location would
            // quietly save icons somewhere the static mount never serves.
            expect(d.iconRoot).to.equal(path.resolve(__dirname, '../../src/content/icons'));
        });
    });
}

require('./icon_downloader.test/support/lifecycle.js');
require('./icon_downloader.test/support/flavors_discovery.js');
require('./icon_downloader.test/support/discovery_status.js');
require('./icon_downloader.test/support/token_processing.js');
require('./icon_downloader.test/support/source_bytes_1.js');
require('./icon_downloader.test/support/source_bytes_2.js');
require('./icon_downloader.test/support/source_storage.js');
require('./icon_downloader.test/support/cleanup.js');
require('./icon_downloader.test/support/flavor_processing.js');
require('./icon_downloader.test/support/networking_logging.js');
require('./icon_downloader.test/support/edge_cases.js');
