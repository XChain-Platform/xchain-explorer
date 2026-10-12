// Finds every unit spec that needs a sibling xchain-* checkout, directly or
// through a support file it requires, so the mutation config can ignore them.
// Stryker runs the dry run from .stryker-tmp/sandbox-*, where no sibling repo
// sits beside the checkout, so these specs fail there under
// XCHAIN_REQUIRE_SIBLINGS=1 and take the whole run down. Generating the list
// at load time means a new sibling-reading test cannot reopen that failure.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const UNIT = path.join(ROOT, 'test', 'unit');

// Code-level markers only: a comment that names xchain-hub/... is not a dependency.
const SIBLING_MARKERS = [
    /sibling_checkout/,
    /siblingCheckout/,
    /XCHAIN_REQUIRE_SIBLINGS/,
    /['"`](?:\.\.\/)+xchain-[a-z-]+/,
    /['"`]\.\.['"`]\s*,[^)]*['"`]xchain-[a-z-]+/,
    /require\(\s*['"]xchain-(?!explorer)[a-z-]+/
];

function walk(dir, out) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p, out);
        else if (e.name.endsWith('.js')) out.push(p);
    }
    return out;
}

function relativeRequires(file, src) {
    const found = [];
    const re = /require\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g;
    let m;
    while ((m = re.exec(src))) {
        const base = path.resolve(path.dirname(file), m[1]);
        for (const c of [base, base + '.js', path.join(base, 'index.js')])
            if (fs.existsSync(c) && fs.statSync(c).isFile()) { found.push(c); break; }
    }
    return found;
}

export function siblingSpecs() {
    const files = walk(UNIT, []);
    const src = new Map(files.map(f => [f, fs.readFileSync(f, 'utf8')]));
    const direct = new Set(files.filter(f => SIBLING_MARKERS.some(r => r.test(src.get(f)))));
    // Any file that reaches a sibling-reading file through relative requires is
    // itself sibling-dependent; iterate to a fixed point for the transitive case.
    const dependent = new Set(direct);
    for (let changed = true; changed;) {
        changed = false;
        for (const f of files) {
            if (dependent.has(f)) continue;
            if (relativeRequires(f, src.get(f)).some(r => dependent.has(r))) {
                dependent.add(f); changed = true;
            }
        }
    }
    return files
        .filter(f => f.endsWith('.test.js') && dependent.has(f))
        .map(f => path.relative(ROOT, f).split(path.sep).join('/'))
        .sort();
}
