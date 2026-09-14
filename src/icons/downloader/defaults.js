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
 *
 * IconDownloader, default settings
 *
 * The iconDownload settings a config.json block overrides key by key
 * (IconDownloader.start merges it over these).
 *
 ********************************************************************/

const DEFAULTS = {
    enabled:         false,
    intervalMinutes: 15,
    batchSize:       50,
    fetchTimeoutMs:  5000,
    maxBytes:        5 * 1024 * 1024,
    iconSize:        64,
    requestDelayMs:  200,
    maxAttempts:     4,
    recursionLimit:  2,
    convertBin:      '/usr/bin/convert',
    // Wall-clock ceiling on each subprocess. maxBytes caps the DOWNLOAD, never
    // the DECODE, so a well-formed ~5MB raster declaring enormous dimensions
    // still costs ImageMagick minutes of grinding. runOnce holds the _running
    // re-entrancy guard for the whole pass, so one such image would otherwise
    // stall the icon pipeline for every coin and network until the process is
    // restarted. On expiry Node SIGKILLs the child and writeIcon fails the row
    // into the normal backoff path.
    convertTimeoutMs: 20000,
    // ImageMagick pixel-cache ceilings, passed as -limit on every invocation.
    // The service ships no policy.xml, so these argv limits are the only bound
    // on IM's allocation: a 5MB PNG declaring 50000x50000 decodes to tens of
    // gigabytes of pixel buffer otherwise. disk 0 makes the overflow fail fast
    // instead of thrashing a temp file. Only memory/map/disk are used because
    // they exist in every IM6 and IM7 build; an unrecognized -limit resource
    // type aborts the conversion, which would take every icon down with it.
    convertMemoryLimit: '256MiB',
    convertMapLimit:    '256MiB',
    convertDiskLimit:   '0',
};

module.exports = DEFAULTS;
