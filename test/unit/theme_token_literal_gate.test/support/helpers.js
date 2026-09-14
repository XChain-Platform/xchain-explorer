'use strict';

// Strip /* ... */ comments but keep every newline, so a later offset-to-line
// count still lines up with the original file. A commented-out declaration
// (xchain.css carries two, both legacy hex colors) must not be scanned.
function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
}

// The custom properties one selector block declares, as name -> value.
// Whitespace between the selector parts and the brace is normalised, because
// the shipped files are hand-formatted and the vendored Bootstrap build is
// minified; matching the literal text would make this helper agree with one and
// silently return null for the other.
function declarationsIn(css, selector) {
  const stripped = stripComments(css);
  const pattern = selector.trim().split(/\s+/).map((part) =>
    part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s*');
  // Anchored on a preceding block/statement boundary so a selector cannot be
  // matched as the tail of a longer one (":root" inside ":not(:root)").
  const re = new RegExp('(?:^|[};])\\s*' + pattern + '\\s*\\{([^{}]*)\\}');
  const m = re.exec(stripped);
  if (!m) return null;
  const out = {};
  for (const decl of m[1].split(';')) {
    const colon = decl.indexOf(':');
    if (colon === -1) continue;
    out[decl.slice(0, colon).trim()] = decl.slice(colon + 1).trim();
  }
  return out;
}

module.exports = { declarationsIn, stripComments };
