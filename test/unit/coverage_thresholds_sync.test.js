const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// The coverage ratchet keeps its floors in two places: bin/coverage-thresholds.json,
// which is what a human reads, and the c8 flags inside the coverage:check npm script,
// which is what CI obeys. Every one of those files says "keep both in sync" and
// nothing enforced it, so a floor could describe a ratchet the job was not running.
// The failure mode is not hypothetical: xchain-dashboard's ci.yml called a
// coverage:check script that did not exist in that repo at all, a job that could only
// ever exit 1, and the missing-script case is asserted here for that reason.
describe('coverage ratchet floors', () => {
  const repoRoot = path.join(__dirname, '..', '..');
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  const declared = JSON.parse(
    fs.readFileSync(path.join(repoRoot, 'bin', 'coverage-thresholds.json'), 'utf8'),
  );

  it('ships the coverage:check script the CI coverage job invokes', () => {
    assert.equal(
      typeof (pkg.scripts || {})['coverage:check'],
      'string',
      'ci.yml runs `npm run coverage:check`; without the script the job can only exit 1',
    );
  });

  it('enforces every declared floor, at the declared value', () => {
    const script = pkg.scripts['coverage:check'];
    for (const metric of ['lines', 'statements', 'branches', 'functions']) {
      const flag = script.match(new RegExp('--' + metric + '\\s+([0-9.]+)'));
      assert.ok(flag, `coverage:check does not enforce --${metric}, so that floor is decorative`);
      assert.equal(
        Number(flag[1]),
        declared[metric],
        `${metric} floor drifted: thresholds.json says ${declared[metric]}, coverage:check enforces ${flag[1]}`,
      );
    }
  });

  it('fails the job on a shortfall rather than only reporting it', () => {
    assert.match(pkg.scripts['coverage:check'], /--check-coverage/);
  });

  // The ratchet excludes src/hub/**, the two byte-identical vendored copies of the
  // hub-DB mirror client this repo may not edit (see vendoredExclusion in
  // thresholds.json for why). That exclusion is a CLI flag c8 has no canonical list
  // for, so it is duplicated across the two coverage scripts the same way the floors
  // are duplicated into thresholds.json, and guarded here for the same reason: a
  // silent widening would turn a narrow vendored carve-out into a blanket escape
  // that lets the explorer's own untested code through the floor unseen.
  const excludesOf = (script) => (script.match(/--exclude\s+'([^']+)'/g) || [])
    .map((flag) => flag.match(/--exclude\s+'([^']+)'/)[1]);

  it('excludes the vendored hub mirror, and nothing else, from the ratchet', () => {
    assert.deepStrictEqual(
      excludesOf(pkg.scripts['coverage:check']),
      ['src/hub/**'],
      'the ratchet must carve out only the vendored mirror; any other exclusion hides code the explorer owns and owes tests',
    );
  });

  it('measures the same tree in the reporting script as in the enforcing one', () => {
    assert.deepStrictEqual(
      excludesOf(pkg.scripts.coverage),
      excludesOf(pkg.scripts['coverage:check']),
      'coverage and coverage:check disagree on what they measure, so the report a human reads is not the tree CI enforces',
    );
  });

  it('documents the exclusion where a human reads the floors', () => {
    assert.match(
      String(declared.vendoredExclusion || ''),
      /src\/hub/,
      'thresholds.json must say what is carved out of the measurement and why, or the number it floors is unexplained',
    );
  });
});
