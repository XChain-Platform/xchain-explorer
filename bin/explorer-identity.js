#!/usr/bin/env node
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
 *
 * What this build of the explorer IS, in one re-derivable JSON document.
 *
 * WHY THE EXPLORER GETS A DIFFERENT PIN FROM THE INDEXER. The indexer pins four
 * consensus numbers because it decides state. The explorer decides nothing: it
 * renders what the indexer already decided, so it has no armed-map fingerprint
 * and no rules digest to compare. Its identity is instead the set of things a
 * structural refactor can silently break while every test still reads green:
 *
 *   twins        the nine top-level files that are BYTE-IDENTICAL copies of an
 *                indexer canonical. Two of them (equivocation_header.js,
 *                stake_weighted_quorum.js) are named by no sync script at all
 *                and are held only by sibling tests that SKIP on a missing
 *                path, which is exactly how a twin unpins without a red run.
 *   routes       the public route surface, parsed out of XChainExplorer.js by
 *                the one platform parser the two explorer sweeps already share.
 *                A rename tier that touches a string literal moves a route, and
 *                a moved route is a 404 on a page that used to answer.
 *   fixtures     the golden and the two baselines, the byte pins on rendered
 *                output. Their sizes are recorded beside their hashes because a
 *                truncated regeneration is the failure that looks most like a
 *                legitimate diff.
 *   suites       what every npm script actually COLLECTS, file by file and
 *                title by title. A count proves nothing: a renamed file can
 *                leave one glob while another joins it and the total holds.
 *   coverage     the four c8 floors. A wave that deletes covered source moves
 *                them without touching behaviour, so they are read here rather
 *                than rediscovered at the barrier.
 *   prototype    the sorted Database.prototype method list and the enumerable
 *                key count. The db.js carve rebuilds this surface by descriptor
 *                copy; the list says nothing was dropped and the zero says the
 *                copy kept every method non-enumerable.
 *
 * WHY IT NEEDS NO DATABASE AND NO SERVER. Every value above comes from the
 * source tree. `mocha --dry-run` loads each spec file and walks the suite tree
 * without invoking one hook or test body, so titles are all present with
 * nothing connected. require('../src/db.js') loads the class and never
 * constructs it. That is what makes this pin cheap enough to re-take at every
 * milestone instead of once.
 *
 * ONE REPO ROOT, WHICH IS THE TRAP THIS FILE EXISTS TO AVOID. The indexer's
 * bin/suite-title-map.js resolves its repo root from its own __dirname, so
 * invoking it by its indexer path from an explorer checkout silently grades the
 * INDEXER and exits 0. Its collection logic (splitCommand, mochaArgsFor,
 * collect, buildMap, expand) is therefore vendored below rather than required
 * across repos: origin xchain-indexer/bin/suite-title-map.js, kept behaviourally
 * identical so a pin taken by either tool has the same shape.
 *
 * EVERY VALUE IS READ FROM THE CHECKED-OUT WORKING TREE, never from a git blob.
 * Mixing HEAD blobs with require()d modules would pin two different trees in one
 * document; run it in a clean worktree and the two are the same thing.
 *
 * NO ABSOLUTE PATH REACHES THE OUTPUT. The pin is compared between the main
 * checkout and a throwaway worktree, and a recorded source path would make two
 * readings of the same commit differ for a reason that is not a code change.
 *
 * THERE ARE TWO COMMITTED PINS, AND THEY ANSWER DIFFERENT QUESTIONS.
 *
 *   bin/pins/at1-explorer-identity.8f251b6.json   the FROZEN base record, taken
 *       at 8f251b6 before any lane of this pass committed, carrying a `rev`.
 *       Never re-taken: it is the reading no lane has moved, which is the only
 *       thing the M2 prototype comparison and AT7's suite identity can be
 *       measured against. After the test renames land it holds through the
 *       declared rename map, not byte for byte.
 *   bin/pins/at1-explorer-identity.json           the LIVE pin, re-derived and
 *       committed by the landing lane at every wave barrier. It carries no rev
 *       because its rev is the commit that carries it, and byte equality with a
 *       fresh derivation is what AT1 asserts at that barrier.
 *
 * USAGE
 *   node bin/explorer-identity.js                     the JSON on stdout
 *   node bin/explorer-identity.js --out <file>        write it instead
 *   node bin/explorer-identity.js --out <file> --rev <sha>
 *                                                     stamp the tree it
 *                                                     describes; the frozen
 *                                                     base record only
 *   node bin/explorer-identity.js --summary           the headline values only
 *   node bin/explorer-identity.js --compare <pin>     diff the tree against a
 *                                                     pin, exit 1 on any
 *                                                     difference, printing all
 *   node bin/explorer-identity.js --compare <pin> --rename-map <file>
 *                                                     the same, with the moving
 *                                                     commit's {old: new} test
 *                                                     paths applied to the pin
 *   node bin/explorer-identity.js --compare <pin> --no-suites
 *                                                     every section EXCEPT the
 *                                                     title map, which is also
 *                                                     the only way a pin that
 *                                                     lacks one is accepted
 *
 ********************************************************************/

'use strict';

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const MOCHA_BIN = path.join(REPO_ROOT, 'node_modules', '.bin', 'mocha');

// The structure pass's frozen twin set: the nine top-level
// files this pass may not move, rename or change one byte of. Listed here by
// hand rather than globbed, because the point of the pin is to notice a file
// LEAVING the set as loudly as it notices one changing.
const TWIN_FILES = [
    'src/checkpoint_commitment_activation.js',
    'src/equivocation_header.js',
    'src/list_edit_resolution_activation.js',
    'src/merkle.js',
    'src/mirror_admission_activation.js',
    'src/price_batching_floor_activation.js',
    'src/retraction_signing_activation.js',
    'src/stake_weighted_quorum.js',
    'src/state_subtree_activation.js',
];

// The three byte pins on rendered output. Only the first has a generator
// (bin/gen-action-detail-golden.js); the other two are compared, never rebuilt.
const FIXTURE_FILES = [
    'test/fixtures/action-detail-golden.json',
    'test/fixtures/list-page-baseline.json',
    'test/fixtures/template-baseline.html',
];

const COVERAGE_METRICS = ['lines', 'statements', 'branches', 'functions'];

function sha256(buf) {
    return crypto.createHash('sha256').update(buf).digest('hex');
}

/** {path, bytes, sha256} for a repo-relative file, or a `missing` marker. */
function digestFile(rel) {
    const abs = path.join(REPO_ROOT, rel);
    if (!fs.existsSync(abs)) return { path: rel, missing: true };
    const buf = fs.readFileSync(abs);
    return { path: rel, bytes: buf.length, sha256: sha256(buf) };
}

/**
 * The platform's explorer route parser, found by walking UP from this repo.
 *
 * From the real checkout it is the sibling `../claude/bin/lib/explorer-routes.js`,
 * but every lane of this pass runs in tmp/<purpose>/<repo>, where that sibling is
 * two directories further up and only the xchain-* siblings are symlinked in. A
 * hard-coded '../claude' therefore throws in exactly the tree the pin is taken
 * in, so the ascent is the resolution rule and the sibling is just its first hit.
 */
function resolveRoutesLib() {
    const rel = path.join('claude', 'bin', 'lib', 'explorer-routes.js');
    let dir = path.dirname(REPO_ROOT);
    for (let up = 0; up < 6; up += 1) {
        const candidate = path.join(dir, rel);
        if (fs.existsSync(candidate)) return candidate;
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    throw new Error(`explorer-identity: ${rel} not found above ${REPO_ROOT}; `
        + 'the route digest is derived by the platform parser and has no second implementation');
}

/**
 * The public route surface and one hash over it.
 *
 * The digest is taken over the tables in SOURCE ORDER, not sorted: the order is
 * already deterministic (one parse of one file), and a route that moves between
 * tables is a change worth seeing. `counts` and the tables themselves are kept
 * beside the hash because two mismatched hashes say nothing about what to fix.
 */
function routeIdentity() {
    const { readRouteTables } = require(resolveRoutesLib());
    const tables = readRouteTables(path.join(REPO_ROOT, 'src', 'XChainExplorer.js'));
    const ordered = { pages: tables.pages, feeds: tables.feeds, apis: tables.apis };
    return {
        digest_sha256: sha256(JSON.stringify(ordered)),
        counts: {
            pages: ordered.pages.length,
            feeds: ordered.feeds.length,
            apis: ordered.apis.length,
            total: ordered.pages.length + ordered.feeds.length + ordered.apis.length,
        },
        tables: ordered,
    };
}

/**
 * The four c8 floors, read from the package.json script that CI actually runs.
 *
 * bin/coverage-thresholds.json mirrors the same four and test/unit/
 * coverage-thresholds-sync.test.js holds the two together, so the mirror is
 * recorded beside them: if that guard ever stops running, the pin still shows
 * the pair drifting apart.
 */
function coverageIdentity() {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
    const script = (pkg.scripts || {})['coverage:check'] || '';
    const script_values = {};
    for (const metric of COVERAGE_METRICS) {
        const m = script.match(new RegExp(`--${metric}\\s+([0-9.]+)`));
        script_values[metric] = m ? Number(m[1]) : null;
    }
    const mirrorPath = path.join(REPO_ROOT, 'bin', 'coverage-thresholds.json');
    const mirror_values = {};
    if (fs.existsSync(mirrorPath)) {
        const mirror = JSON.parse(fs.readFileSync(mirrorPath, 'utf8'));
        for (const metric of COVERAGE_METRICS) {
            mirror_values[metric] = metric in mirror ? Number(mirror[metric]) : null;
        }
    }
    const agrees = COVERAGE_METRICS.every((m) => script_values[m] === mirror_values[m]);
    return { script_values, mirror_values, mirror_agrees: agrees };
}

/**
 * Database.prototype's method surface.
 *
 * getOwnPropertyNames, not Object.keys: class methods are non-enumerable, so
 * Object.keys reports zero and would pin nothing at all. That zero is recorded
 * on purpose as `enumerable_keys`, because the carve reinstalls these methods by
 * descriptor copy and a copy done with assignment would make them enumerable,
 * changing for-in behaviour everywhere the class is spread or iterated.
 */
function prototypeIdentity() {
    const Database = require(path.join(REPO_ROOT, 'src', 'db.js'));
    const names = Object.getOwnPropertyNames(Database.prototype)
        .filter((n) => n !== 'constructor')
        .sort();
    return {
        count: names.length,
        enumerable_keys: Object.keys(Database.prototype).length,
        names,
    };
}

/*
 * ---------------------------------------------------------------------------
 * Suite collection, vendored from xchain-indexer/bin/suite-title-map.js so that
 * REPO_ROOT above is the ONE root every value in this document is taken from.
 * ---------------------------------------------------------------------------
 */

/**
 * A shell-ish split that keeps quoted globs whole. The scripts are plain
 * command lines with quoted glob arguments and the occasional leading
 * VAR=value; nothing here has a subshell or a redirect, and a script that grows
 * one is reported as unsupported rather than mis-parsed.
 */
function splitCommand(script) {
    const tokens = [];
    let current = '';
    let quote = null;
    let started = false;
    let quoted = false;
    const push = () => { tokens.push({ value: current, quoted }); current = ''; started = false; quoted = false; };
    for (const ch of script) {
        if (quote) {
            if (ch === quote) quote = null;
            else current += ch;
            continue;
        }
        if (ch === '"' || ch === "'") { quote = ch; started = true; quoted = true; continue; }
        if (/\s/.test(ch)) {
            if (started || current) push();
            continue;
        }
        current += ch;
    }
    if (started || current) push();
    return tokens;
}

// Shell operators, recognised only on an UNQUOTED token: --grep '@x.*(a|b)'
// carries a pipe inside its pattern and is a perfectly ordinary single command.
const SHELL_OPERATOR = /^(?:&&|\|\||[|;]|[<>]+)$/;

/**
 * What a test script actually is: one mocha command, a chain of other npm
 * scripts, or something this tool will not guess at.
 * @returns {{args: string[], env: object}|{composite: string[]}|{skip: string}}
 */
function mochaArgsFor(script) {
    const tokens = splitCommand(script);
    const operators = tokens.filter((t) => !t.quoted && SHELL_OPERATOR.test(t.value));
    if (operators.length) {
        const members = [];
        for (let i = 0; i < tokens.length - 1; i += 1) {
            if (tokens[i].value !== 'npm') continue;
            // `npm test` is the same member as `npm run test` and has to land in
            // the list under the same name, or the union looks short by a suite.
            if (tokens[i + 1].value === 'run' && tokens[i + 2]) members.push(tokens[i + 2].value);
            else if (tokens[i + 1].value === 'test') members.push('test');
        }
        if (members.length) return { composite: members };
        return { skip: 'shell composition this tool does not expand' };
    }
    // Leading environment assignments (FUZZ_ITERATIONS=10000 mocha ...) are set
    // on the child rather than dropped: a suite may name its title from one.
    const env = {};
    let i = 0;
    while (i < tokens.length && !tokens[i].quoted && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i].value)) {
        const eq = tokens[i].value.indexOf('=');
        env[tokens[i].value.slice(0, eq)] = tokens[i].value.slice(eq + 1);
        i += 1;
    }
    if (!tokens[i] || tokens[i].value !== 'mocha') {
        return { skip: `not a mocha command (runs ${tokens[i] ? tokens[i].value : 'nothing'})` };
    }
    return { args: tokens.slice(i + 1).map((t) => t.value), env };
}

/**
 * Titles for one script, keyed by repo-relative test file.
 *
 * Each script runs with its OWN arguments, unchanged apart from the reporter and
 * the dry run. A run that "tidied" the arguments would pin a different
 * collection than the one CI executes, and a --grep stays because the filtered
 * set is that script's identity.
 */
function collect(script) {
    const parsed = mochaArgsFor(script);
    if (parsed.skip) return { skipped: parsed.skip };
    // A chain of npm scripts collects exactly the union of its members, each of
    // which is pinned in its own right; restating their titles here would pin
    // the same suites twice and make one rename look like two.
    if (parsed.composite) return { composite: parsed.composite.slice().sort() };

    const res = spawnSync(MOCHA_BIN, ['--dry-run', '--reporter', 'json', ...parsed.args], {
        cwd: REPO_ROOT,
        env: { ...process.env, ...parsed.env },
        maxBuffer: 256 * 1024 * 1024,
        encoding: 'utf8',
    });
    if (res.error) return { error: String(res.error.message) };

    let report;
    try {
        // The json reporter writes the report to stdout, but a spec file that
        // logs at load time writes there too; the report is the last JSON object,
        // so parsing starts at the last line that opens one.
        const start = res.stdout.indexOf('{\n  "stats"');
        report = JSON.parse(start === -1 ? res.stdout : res.stdout.slice(start));
    } catch (e) {
        return { error: `unparseable mocha json (exit ${res.status}): ${res.stderr.slice(0, 400)}` };
    }

    const files = {};
    for (const test of (report.tests || []).concat(report.pending || [])) {
        const rel = test.file ? path.relative(REPO_ROOT, test.file) : '(no file)';
        if (!files[rel]) files[rel] = [];
        files[rel].push(test.fullTitle);
    }
    const sorted = {};
    let titles = 0;
    for (const rel of Object.keys(files).sort()) {
        sorted[rel] = files[rel].slice().sort();
        titles += sorted[rel].length;
    }
    return { fileCount: Object.keys(sorted).length, titleCount: titles, files: sorted };
}

function setKey(titles) {
    return crypto.createHash('sha256').update(titles.join('\n')).digest('hex').slice(0, 16);
}

/**
 * Every npm script in package.json, classified.
 *
 * ALL of them, not just the test-prefixed ones: the eight that build, serve or
 * vendor are recorded by name as `not_a_test_script` so that a script appearing,
 * disappearing or changing category is a visible difference rather than a silent
 * absence from the map. Titles are stored once in `title_sets`, keyed by a hash
 * of the list, and each script's `files` map points a test file at the set it
 * contributed; written flat the pin is megabytes of text repeated across the
 * scripts whose globs overlap, and the indirection is lossless.
 */
function suiteIdentity(only) {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
    const names = Object.keys(pkg.scripts || {}).sort();
    const titleSets = {};
    const scripts = {};
    const totals = { scripts: names.length, collected: 0, skipped: 0, composite: 0, errored: 0, not_a_test_script: 0 };
    for (const name of names) {
        if (only && name !== only) continue;
        if (!name.startsWith('test')) {
            scripts[name] = { not_a_test_script: true };
            totals.not_a_test_script += 1;
            continue;
        }
        const result = collect(pkg.scripts[name]);
        if (result.files) {
            const files = {};
            for (const rel of Object.keys(result.files)) {
                const key = setKey(result.files[rel]);
                titleSets[key] = result.files[rel];
                files[rel] = key;
            }
            result.files = files;
            totals.collected += 1;
        } else if (result.skipped) totals.skipped += 1;
        else if (result.composite) totals.composite += 1;
        else if (result.error) totals.errored += 1;
        scripts[name] = result;
    }
    const sortedSets = {};
    for (const key of Object.keys(titleSets).sort()) sortedSets[key] = titleSets[key];
    return { totals, title_sets: sortedSets, scripts };
}

/** The flat {file: [titles]} view of one script in an identity, pin or fresh. */
function expandScript(identity, scriptName) {
    const s = identity.suites.scripts[scriptName];
    if (!s || !s.files) return null;
    const out = {};
    for (const rel of Object.keys(s.files).sort()) out[rel] = identity.suites.title_sets[s.files[rel]] || [];
    return out;
}

/**
 * Everything above, in one fixed key order so the document is stable.
 *
 * `rev` is emitted ONLY when --rev names one, and it is what separates the two
 * committed pins. The frozen base record at 8f251b6 carries a rev because it is
 * never re-taken and later waves have to be able to say which tree it describes;
 * the live pin carries none, because it is re-derived at every barrier and a
 * stamped rev would make the derivation differ from its own pin on every commit.
 */
function buildIdentity(opts) {
    const options = opts || {};
    const identity = {
        tool: 'explorer-identity',
        format: 1,
        repo: 'xchain-explorer',
    };
    if (options.rev) identity.rev = options.rev;
    identity.twins = TWIN_FILES.slice().sort().map(digestFile);
    identity.routes = routeIdentity();
    identity.fixtures = FIXTURE_FILES.slice().sort().map(digestFile);
    identity.coverage = coverageIdentity();
    identity.prototype = prototypeIdentity();
    // Skipped rather than emitted empty: an empty suite map would compare clean
    // against anything, which is the silent pass this whole pin exists to refuse.
    if (options.noSuites !== true) identity.suites = suiteIdentity(options.script);
    return identity;
}

/**
 * The document as bytes.
 *
 * Escaped to pure ASCII on the way out: test titles are captured verbatim and
 * some carry characters the platform's prose rules keep out of committed files.
 * Escaping changes the encoding and not one parsed character, so the pin stays
 * exactly what mocha reported.
 */
function serialize(identity) {
    return `${JSON.stringify(identity, null, 2)
        .replace(/[-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)}\n`;
}

function byPath(entries) {
    const out = {};
    for (const e of entries || []) out[e.path] = e;
    return out;
}

/**
 * Pin against tree, section by section.
 *
 * `renames` is the moving commit's declared {oldPath: newPath}; a pin entry is
 * compared under its NEW name, so a pure rename reports no difference while a
 * rename that also changed a title still does. It is applied to test paths only
 * (suite files and fixtures): a rename map that could move a twin or a src file
 * would let this pin excuse the one class of change it exists to catch.
 */
function compareIdentities(pin, fresh, renames, opts) {
    const options = opts || {};
    const map = renames || {};
    const rename = (rel) => (Object.prototype.hasOwnProperty.call(map, rel) ? map[rel] : rel);
    const differences = [];
    const push = (section, kind, detail) => differences.push({ section, kind, detail });

    const pinTwins = byPath(pin.twins);
    const freshTwins = byPath(fresh.twins);
    for (const rel of Array.from(new Set(Object.keys(pinTwins).concat(Object.keys(freshTwins)))).sort()) {
        const a = pinTwins[rel];
        const b = freshTwins[rel];
        if (!a) { push('twins', 'twin_added', rel); continue; }
        if (!b) { push('twins', 'twin_dropped', rel); continue; }
        if (a.missing || b.missing) {
            if (a.missing !== b.missing) push('twins', 'twin_presence', `${rel}: pin ${a.missing ? 'missing' : 'present'}, tree ${b.missing ? 'missing' : 'present'}`);
            continue;
        }
        if (a.sha256 !== b.sha256) push('twins', 'twin_sha256', `${rel}: pin ${a.sha256}, tree ${b.sha256}`);
        else if (a.bytes !== b.bytes) push('twins', 'twin_bytes', `${rel}: pin ${a.bytes}, tree ${b.bytes}`);
    }

    if (pin.routes.digest_sha256 !== fresh.routes.digest_sha256) {
        push('routes', 'route_digest', `pin ${pin.routes.digest_sha256}, tree ${fresh.routes.digest_sha256}`);
    }
    for (const key of ['pages', 'feeds', 'apis', 'total']) {
        if (pin.routes.counts[key] !== fresh.routes.counts[key]) {
            push('routes', 'route_count', `${key}: pin ${pin.routes.counts[key]}, tree ${fresh.routes.counts[key]}`);
        }
    }
    for (const table of ['pages', 'feeds', 'apis']) {
        const before = new Set((pin.routes.tables[table] || []).map((r) => JSON.stringify(r)));
        const after = new Set((fresh.routes.tables[table] || []).map((r) => JSON.stringify(r)));
        for (const r of Array.from(before).filter((x) => !after.has(x)).sort()) push('routes', 'route_dropped', `${table} ${r}`);
        for (const r of Array.from(after).filter((x) => !before.has(x)).sort()) push('routes', 'route_added', `${table} ${r}`);
    }

    const pinFix = byPath(pin.fixtures);
    const freshFix = byPath(fresh.fixtures);
    const fixPaths = Array.from(new Set(Object.keys(pinFix).map(rename).concat(Object.keys(freshFix)))).sort();
    for (const rel of fixPaths) {
        const a = pinFix[rel] || pinFix[Object.keys(pinFix).find((k) => rename(k) === rel)];
        const b = freshFix[rel];
        if (!a) { push('fixtures', 'fixture_added', rel); continue; }
        if (!b) { push('fixtures', 'fixture_dropped', rel); continue; }
        if (a.sha256 !== b.sha256) push('fixtures', 'fixture_sha256', `${rel}: pin ${a.sha256}, tree ${b.sha256}`);
        if (a.bytes !== b.bytes) push('fixtures', 'fixture_bytes', `${rel}: pin ${a.bytes}, tree ${b.bytes}`);
    }

    for (const metric of COVERAGE_METRICS) {
        if (pin.coverage.script_values[metric] !== fresh.coverage.script_values[metric]) {
            push('coverage', 'threshold', `${metric}: pin ${pin.coverage.script_values[metric]}, tree ${fresh.coverage.script_values[metric]}`);
        }
    }
    if (pin.coverage.mirror_agrees !== fresh.coverage.mirror_agrees) {
        push('coverage', 'mirror_agrees', `pin ${pin.coverage.mirror_agrees}, tree ${fresh.coverage.mirror_agrees}`);
    }

    if (pin.prototype.count !== fresh.prototype.count) {
        push('prototype', 'count', `pin ${pin.prototype.count}, tree ${fresh.prototype.count}`);
    }
    if (pin.prototype.enumerable_keys !== fresh.prototype.enumerable_keys) {
        push('prototype', 'enumerable_keys', `pin ${pin.prototype.enumerable_keys}, tree ${fresh.prototype.enumerable_keys}`);
    }
    const freshNames = new Set(fresh.prototype.names);
    const pinNames = new Set(pin.prototype.names);
    for (const n of pin.prototype.names.filter((x) => !freshNames.has(x))) push('prototype', 'method_dropped', n);
    for (const n of fresh.prototype.names.filter((x) => !pinNames.has(x))) push('prototype', 'method_added', n);

    // Every section is compared unless --no-suites says otherwise. A pin with no
    // title map is a DIFFERENCE by default and not a section quietly skipped:
    // the one thing worse than a red pin is a pin that passes because the
    // expensive half of it was missing.
    if (options.noSuites === true) return differences;
    if (!pin.suites || !fresh.suites) {
        push('suites', 'section_missing',
            `${!pin.suites ? 'the pin' : 'the tree reading'} carries no suite title map; `
            + 'pass --no-suites to compare the other sections on purpose');
        return differences;
    }

    const scriptNames = Array.from(new Set(Object.keys(pin.suites.scripts).concat(Object.keys(fresh.suites.scripts)))).sort();
    for (const name of scriptNames) {
        const a = pin.suites.scripts[name];
        const b = fresh.suites.scripts[name];
        if (!a) { push('suites', 'script_added', name); continue; }
        if (!b) { push('suites', 'script_dropped', name); continue; }
        const category = (s) => (s.files ? 'collected' : s.skipped ? 'skipped' : s.composite ? 'composite'
            : s.error ? 'error' : 'not_a_test_script');
        if (category(a) !== category(b)) {
            push('suites', 'script_category', `${name}: pin ${category(a)}, tree ${category(b)}`);
            continue;
        }
        const before = expandScript(pin, name);
        const after = expandScript(fresh, name);
        if (!before || !after) continue;
        const mapped = {};
        for (const rel of Object.keys(before)) mapped[rename(rel)] = before[rel];
        for (const rel of Array.from(new Set(Object.keys(mapped).concat(Object.keys(after)))).sort()) {
            if (!mapped[rel]) { push('suites', 'file_added', `[${name}] ${rel}`); continue; }
            if (!after[rel]) { push('suites', 'file_dropped', `[${name}] ${rel}`); continue; }
            for (const t of mapped[rel].filter((x) => !after[rel].includes(x))) push('suites', 'title_dropped', `[${name}] ${rel} :: ${t}`);
            for (const t of after[rel].filter((x) => !mapped[rel].includes(x))) push('suites', 'title_added', `[${name}] ${rel} :: ${t}`);
        }
    }

    return differences;
}

function summary(identity) {
    const lines = [];
    lines.push(`repo:                 ${identity.repo}${identity.rev ? ` (rev ${identity.rev})` : ''}`);
    for (const t of identity.twins) lines.push(`twin ${t.path.padEnd(46)}${t.missing ? 'MISSING' : t.sha256}`);
    lines.push(`route digest:         ${identity.routes.digest_sha256}`);
    lines.push(`route counts:         ${identity.routes.counts.pages} pages, ${identity.routes.counts.feeds} feeds, `
        + `${identity.routes.counts.apis} apis, ${identity.routes.counts.total} total`);
    for (const f of identity.fixtures) {
        lines.push(`fixture ${path.basename(f.path).padEnd(30)}${f.missing ? 'MISSING' : `${String(f.bytes).padStart(8)} bytes  ${f.sha256}`}`);
    }
    lines.push(`coverage floors:      ${COVERAGE_METRICS.map((m) => `${m} ${identity.coverage.script_values[m]}`).join(', ')}`
        + `  (mirror agrees: ${identity.coverage.mirror_agrees})`);
    lines.push(`Database.prototype:   ${identity.prototype.count} methods, ${identity.prototype.enumerable_keys} enumerable keys`);
    lines.push(identity.suites
        ? `npm scripts:          ${identity.suites.totals.scripts} total, ${identity.suites.totals.collected} collected, `
          + `${identity.suites.totals.skipped} skipped, ${identity.suites.totals.not_a_test_script} not test scripts, `
          + `${identity.suites.totals.errored} errored`
        : 'npm scripts:          not collected (--no-suites)');
    return lines.join('\n');
}

function parseArgs(argv) {
    const opts = {};
    for (let i = 0; i < argv.length; i += 1) {
        if (argv[i] === '--out') { opts.out = path.resolve(argv[i + 1]); i += 1; }
        else if (argv[i] === '--compare') { opts.compare = path.resolve(argv[i + 1]); i += 1; }
        else if (argv[i] === '--rename-map') { opts.renameMap = path.resolve(argv[i + 1]); i += 1; }
        else if (argv[i] === '--script') { opts.script = argv[i + 1]; i += 1; }
        else if (argv[i] === '--rev') { opts.rev = argv[i + 1]; i += 1; }
        else if (argv[i] === '--no-suites') opts.noSuites = true;
        else if (argv[i] === '--summary') opts.summary = true;
        else if (argv[i] === '--help' || argv[i] === '-h') opts.help = true;
        else throw new Error(`explorer-identity: unknown argument ${argv[i]}`);
    }
    // --no-suites narrows a COMPARISON on purpose; writing a pin without the
    // title map would leave a permanent artifact that can never fail on a
    // dropped suite, so the flag is refused anywhere it would be committed.
    if (opts.noSuites && !opts.compare) {
        throw new Error('explorer-identity: --no-suites is a comparison flag; '
            + 'a written pin always carries the suite title map');
    }
    return opts;
}

function main() {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.help) {
        process.stdout.write(`${fs.readFileSync(__filename, 'utf8').split('*/')[0]}\n`);
        return;
    }

    const identity = buildIdentity(opts);

    if (opts.compare) {
        const pin = JSON.parse(fs.readFileSync(opts.compare, 'utf8'));
        const renames = opts.renameMap ? JSON.parse(fs.readFileSync(opts.renameMap, 'utf8')) : {};
        const differences = compareIdentities(pin, identity, renames, { noSuites: opts.noSuites });
        const against = path.relative(REPO_ROOT, opts.compare);
        if (!differences.length) {
            process.stdout.write(`explorer identity holds against ${against}`
                + `${opts.renameMap ? ' through the declared rename map' : ''}\n`);
            return;
        }
        // Every difference, never a head: a pin that printed the first N would
        // hide the twin behind a wall of renamed titles.
        process.stdout.write(`${differences.length} difference(s) against ${against}:\n`);
        for (const d of differences) process.stdout.write(`  [${d.section}] ${d.kind} ${d.detail}\n`);
        process.exitCode = 1;
        return;
    }

    const text = serialize(identity);
    if (opts.out) {
        fs.mkdirSync(path.dirname(opts.out), { recursive: true });
        fs.writeFileSync(opts.out, text);
        if (!opts.summary) process.stdout.write(`written to ${path.relative(REPO_ROOT, opts.out)}\n`);
    } else if (!opts.summary) {
        process.stdout.write(text);
    }
    if (opts.summary) process.stdout.write(`${summary(identity)}\n`);
}

if (require.main === module) {
    try {
        main();
    } catch (e) {
        process.stderr.write(`${e.message}\n`);
        process.exit(2);
    }
}

module.exports = {
    REPO_ROOT,
    TWIN_FILES,
    FIXTURE_FILES,
    buildIdentity,
    serialize,
    compareIdentities,
    summary,
    routeIdentity,
    coverageIdentity,
    prototypeIdentity,
    suiteIdentity,
    splitCommand,
    mochaArgsFor,
};
