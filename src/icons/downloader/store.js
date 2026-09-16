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
 * IconDownloader, image store
 *
 * What lands on disk and in the icons row for an icon: the orphaned-PNG sweep,
 * turning fetched bytes into the cached PNG through the sniff-and-convert
 * subprocesses, and the state updates (ok, terminal no-icon, failure with its
 * retry backoff). IconDownloader's methods of the same names delegate here.
 *
 * Every function takes the downloader instance as `dl`. `deps` carries the
 * modules the entry requires (fs/promises, and execFile promisified there): they
 * are handed in rather than required here so a stub a suite installs on
 * src/icons/downloader.js reaches this code as well.
 *
 ********************************************************************/

const crypto  = require('crypto');
const os      = require('os');
const path    = require('path');
// The SQL this code runs (the sanctioned shared-write exception) lives under
// src/db/, where SQL belongs; see that file for the statements.
const iconsDb = require('../../db/icons.js');

// Raster formats only. SVG is deliberately absent: these bytes come from
// on-chain token descriptions (anyone can ISSUE a token with any description),
// writeIcon hands them to ImageMagick `convert`, and IM's SVG renderer
// dereferences external references (xlink:href, XML entities, nested image
// URLs). Those fetches leave `convert`, not the axios client in fetch.js, so they
// never pass SAFE_LOOKUP or rejectPrivateLiteral: an SVG naming
// http://169.254.169.254/ is an egress this pipeline's SSRF guard cannot see,
// and no ImageMagick policy.xml ships with this service to disable the coders.
// The trade is that a token whose only icon is an SVG gets no rendered icon.
const ALLOWED_MIME = new Set([
    'image/png','image/jpeg','image/jpg','image/gif','image/webp',
]);

/**
 * Delete the PNGs of tokens this flavor's DB says have NO icon.
 *
 * markNoIcon keeps disk and DB in step from here on, but ok-with-NULL-icon_hash
 * is a TERMINAL state: discover only revisits a row when the description drifts
 * (b) or when statement (c)'s one-shot matches, so every file already stranded in
 * that state would go on being served forever. This drains that backlog, and is a
 * permanent no-op once it has.
 *
 * Two rules make the deletion safe, and both are the opposite of the obvious
 * shape:
 *
 * 1. It is driven off the DIRECTORY, not off the row set. readdir returns single
 *    path segments and never '.' or '..', so no on-chain ticker string can steer
 *    an unlink out of this flavor's own directory - a row-driven sweep would
 *    build its paths from attacker-controlled `tick` text instead. It is also
 *    the cheap direction: most tokens never had an icon, so the row set is the
 *    large side and the file set the small one.
 *
 * 2. It only ever deletes on a POSITIVE answer. A file goes only when a row
 *    exists and says status='ok' with icon_hash NULL. An empty result set - a
 *    reindexing DB, an unreachable one, a truncated `tokens` table - deletes
 *    nothing, where a "delete whatever the DB does not claim" sweep would wipe
 *    every icon on the host.
 *
 * Rows in 'stale', 'pending' or 'failed' are deliberately left alone: they may
 * still hold a perfectly good icon that is merely due for re-evaluation, and
 * processFlavor's batch drain is what decides their fate.
 *
 * index_tickers.tick is utf8mb4_bin, so IN (...) compares the filename bytes with
 * no case folding - the same reason discover statement (c) converts to binary.
 */
async function sweepOrphanIcons(dl, conn, flavor, deps){
    const { fsp } = deps;
    const iconDir = path.join(dl.iconRoot, flavor.coin, flavor.network);

    let entries;
    try { entries = await fsp.readdir(iconDir); }
    catch (e){ return; }   // no directory for this flavor yet: nothing to reconcile

    const byTick = new Map();
    for(const name of entries){
        if(!name.endsWith('.png')) continue;
        byTick.set(name.slice(0, -'.png'.length), path.join(iconDir, name));
    }
    if(byTick.size === 0) return;

    const ticks = Array.from(byTick.keys());
    let removed = 0;
    // Chunked so the IN list stays inside the statement/packet limits on a host
    // whose icon directory has grown large.
    for(let i = 0; i < ticks.length; i += 500){
        const chunk = ticks.slice(i, i + 500);
        const rows = await iconsDb.selectIconTicksInChunk(conn, chunk);
        for(const r of rows){
            const file = byTick.get(r.tick);
            if(!file) continue;
            await safeUnlink(fsp, file);
            removed++;
        }
    }
    // Silent when it removes nothing, which is every pass after the first.
    if(removed)
        dl.log(`[${flavor.coin}/${flavor.network}] removed ${removed} orphaned icon file(s)`);
}

/**
 * Terminal "this token has no usable icon": clear the DB metadata AND remove
 * whatever PNG is on disk for it.
 *
 * The unlink is the load-bearing half. markOk alone writes icon_hash NULL and
 * touches no filesystem, while processIconRequest (XChainExplorer) serves any
 * file that EXISTS and only 302s to /icon/default.png when it does not. So the
 * database and the disk disagree and the disk wins: a token whose description
 * changed to one with no icon source keeps serving its old image, and this
 * state is terminal (discover only re-stales on a further description change),
 * so it never self-corrects.
 *
 * The stamp branches need it for a second reason: `convert` writes straight to
 * iconPath, so a conversion that fails or is SIGKILLed on the timeout can leave
 * a truncated file there, on top of whatever good icon it was replacing.
 *
 * safeUnlink swallows ENOENT, so the common case (a token that never had an
 * icon) costs one failed unlink and no branch.
 */
async function markNoIcon(dl, conn, iconId, iconPath, descHash, deps){
    const { fsp } = deps;
    await safeUnlink(fsp, iconPath);
    await dl.markOk(conn, iconId, null, null, null, descHash);
}

/******************************************************************
 * Image conversion: write source bytes to a tmp file, run ImageMagick
 * convert to produce a NxN PNG at iconPath, return md5 of result.
 *****************************************************************/
async function writeIcon(dl, bytes, iconPath, deps){
    const { fsp, execFileAsync } = deps;
    const tmp = path.join(os.tmpdir(), 'iconw_' + process.pid + '_' + crypto.randomBytes(4).toString('hex'));
    await fsp.writeFile(tmp, bytes);

    let mime;
    try { mime = await sniffMime(execFileAsync, tmp, dl.cfg.convertTimeoutMs); }
    catch (e){
        await safeUnlink(fsp, tmp);
        throw new Error('mime sniff failed');
    }
    if(!ALLOWED_MIME.has(mime)){
        await safeUnlink(fsp, tmp);
        throw new Error(`unsupported mime '${mime}'`);
    }

    // GIF/WebP: pick the first frame so animated/multi-page sources don't break the resize
    const needsFirstFrame = (mime === 'image/gif' || mime === 'image/webp');
    const srcArg          = needsFirstFrame ? `${tmp}[0]` : tmp;
    const size            = dl.cfg.iconSize;

    // -limit precedes the input on purpose: ImageMagick applies settings in
    // command-line order, so a limit placed after the filename does not bound
    // the read that allocates the pixel cache.
    const convertArgs = [
        '-limit', 'memory', String(dl.cfg.convertMemoryLimit),
        '-limit', 'map',    String(dl.cfg.convertMapLimit),
        '-limit', 'disk',   String(dl.cfg.convertDiskLimit),
        srcArg,
        '-resize', `${size}x${size}!`,
        '-format', 'png',
        iconPath,
    ];

    try {
        await execFileAsync(dl.cfg.convertBin, convertArgs, {
            timeout:    dl.cfg.convertTimeoutMs,
            killSignal: 'SIGKILL',
        });
    } catch (e){
        await safeUnlink(fsp, tmp);
        // A timeout kill leaves stderr empty and the message unhelpful, so name
        // it: the row's last_error is the only place this is visible.
        const killed = (e.killed === true || e.signal === 'SIGKILL');
        throw new Error('convert failed: ' + (killed
            ? `timed out after ${dl.cfg.convertTimeoutMs}ms`
            : (e.stderr || e.message || '')));
    }
    await safeUnlink(fsp, tmp);

    try {
        const buf = await fsp.readFile(iconPath);
        return md5(buf);
    } catch (e){
        return null;
    }
}

// SHARED-WRITE EXCEPTION (#3752): see src/db/icons.js's updateIconOk for
// the statement and the write-boundary note.
async function markOk(conn, iconId, sourceUrl, sourceHash, iconHash, descHash){
    await iconsDb.updateIconOk(conn, sourceUrl, sourceHash, iconHash, descHash, iconId);
}

// SHARED-WRITE EXCEPTION (#3752): see src/db/icons.js's
// updateIconFailedTerminal / updateIconFailedRetry for the statements
// and the write-boundary note.
async function markFailure(dl, conn, iconId, attempts, errMsg){
    if(attempts >= dl.cfg.maxAttempts){
        await iconsDb.updateIconFailedTerminal(conn, attempts, errMsg, iconId);
    } else {
        const sec = backoffSeconds(attempts);
        await iconsDb.updateIconFailedRetry(conn, attempts, errMsg, sec, iconId);
    }
}

// 1h, 1d, 7d, then permanent (capped via maxAttempts)
function backoffSeconds(attempts){
    if(attempts <= 1) return 3600;
    if(attempts === 2) return 86400;
    if(attempts === 3) return 7 * 86400;
    return 30 * 86400;
}

function md5(input){
    return crypto.createHash('md5').update(input).digest('hex');
}

async function safeUnlink(fsp, p){
    try { await fsp.unlink(p); } catch (e) { /* ignore */ }
}

// MIME sniff via the `file` command (works without adding a dependency).
// Bounded like the conversion below it: `file` reads the same hostile bytes,
// and a sniff that never returns wedges the whole pass just as a hung convert
// does, because runOnce holds _running until processToken resolves.
async function sniffMime(execFileAsync, filePath, timeoutMs){
    const { stdout } = await execFileAsync('file', ['--mime-type', '-b', filePath], {
        timeout:    timeoutMs,
        killSignal: 'SIGKILL',
    });
    return stdout.trim();
}

module.exports = { sweepOrphanIcons, markNoIcon, writeIcon, markOk, markFailure, md5 };
