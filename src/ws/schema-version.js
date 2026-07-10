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
 * WS event-envelope schema version, DISTINCT from the explorer build
 * version (which only names the deployment). Every outbound frame is
 * stamped `schema_version` at the three send sinks (WebSocketServer._send,
 * Broadcaster's per-subscriber send in _broadcastToChannelKey, and
 * Broadcaster._send), so subscribers can gate their parsing instead of
 * silently mis-parsing a reshaped payload.
 *
 * BUMP THIS whenever the `data` shape of ANY event (NEW_ACTION,
 * lifecycle events, entity updates, catch-up frames, ...) is renamed,
 * retyped, or restructured in a way an existing consumer could
 * mis-parse. Additive optional fields do NOT require a bump.
 ********************************************************************/

'use strict';

const WS_SCHEMA_VERSION = 1;

module.exports = { WS_SCHEMA_VERSION };
