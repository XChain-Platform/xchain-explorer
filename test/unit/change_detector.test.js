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
 * Unit tests for src/ws/change_detector.js: the indexer-DB poller that turns
 * new blocks/actions into WebSocket events. All collaborators are injected, so
 * no real DB or timers are needed (fake timers used only for the poll loop).
 */

'use strict';

require('./change_detector.test/polling.js');
require('./change_detector.test/events.js');
require('./change_detector.test/batching_and_state.js');
