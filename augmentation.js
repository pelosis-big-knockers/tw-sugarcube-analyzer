// Driving the analyzer to a settled augmentation.
//
// `analyzer.generate` turns ONE Program into a `declare module "twine-sugarcube"`
// block. Getting a correct one takes more than one pass, and the loop that does
// it is subtle enough that every consumer re-implementing it is how they drift.
// So it lives here, and the consumers differ only in what they feed it:
//
//   * bin/lint.js (tw-sugarcube-ts-tools) — options from the project's tsconfig,
//     and it keeps the resulting Program to pull diagnostics off;
//   * tw-server — its own build options, and it writes `text` to disk for the
//     native tsc, which cannot be handed an in-memory file.
//
// `ts` is a parameter, never an import: the language-service plugin must use the
// TypeScript instance tsserver handed it, and callers on the 7.x native line
// have to supply a 5.x/6.x instance because the native compiler exposes no
// in-process Program API.
"use strict";

const fs = require("fs");
const path = require("path");
const { norm } = require("./analyzer.js");
const twee = require("./twee.js");

// Upper bound on regeneration passes (see buildAugmentation). A fixed point is
// reached in two or three for any real project; this only guarantees the loop
// terminates if recovery ever oscillates.
const MAX_GENERATION_PASSES = 8;

/**
 * Every .twee under `root`, projected to TypeScript.
 *
 * @param root    directory to scan
 * @param onWarn  optional (message) => void for non-fatal problems
 * @returns Map of normalized virtual path -> { content, segments, source, virtual, text }
 */
function collectProjections(root, onWarn) {
  const projections = new Map();
  const walk = (dir, depth) => {
    if (depth > twee.MAX_SCAN_DEPTH) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name[0] === ".") continue;
        walk(full, depth + 1);
      } else if (twee.isTweeFile(entry.name)) {
        let text = "";
        try {
          text = fs.readFileSync(full, "utf8");
        } catch (e) {
          continue;
        }
        let projected = { ts: "", segments: [] };
        try {
          projected = twee.project(text);
        } catch (e) {
          /* keep empty */
        }
        const source = full.replace(/\\/g, "/");
        const virtual = source + ".ts";
        // The analyzer's lookup contract keys projections by norm() (which
        // case-folds), so two twee files differing only in case would silently
        // collapse to one entry and the other would never be seen — rare, but
        // say so instead of reporting a clean run.
        const prior = projections.get(norm(virtual));
        if (prior && prior.source !== source && onWarn) {
          onWarn(`${source} and ${prior.source} differ only by case; only one will be analyzed`);
        }
        // Keep the source text: consumers map diagnostics back onto it, and
        // re-reading the file per diagnostic is pure waste.
        projections.set(norm(virtual), { content: projected.ts, segments: projected.segments, source, virtual, text });
      }
    }
  };
  walk(root, 0);
  return projections;
}

/**
 * Build the augmentation for a project, iterating until it stops changing.
 *
 * One pass is not enough: a recovered member type can DEPEND on a previously
 * recovered one. `<<set $hero to setup.makeHero()>>` can only be typed once
 * `setup.makeHero` itself has been declared, so against the empty-augmentation
 * program it comes back `any` — and every error downstream of it silently
 * disappears. The editor plugin regenerates on each program update until the
 * content stops changing (ts-plugin/index.js `refresh`); this reaches that same
 * fixed point, or a consumer reports clean on code the extension squiggles.
 *
 * @param ts       a TypeScript with the in-process compiler API (5.x/6.x line)
 * @param opts.rootNames    real source files to include
 * @param opts.options      ts.CompilerOptions to analyze under
 * @param opts.augPath      where the augmentation lives. MUST be inside the
 *                          project: its `import "twine-sugarcube"` resolves
 *                          relative to this path, and from anywhere else the
 *                          module doesn't resolve and the augmentation is
 *                          silently dropped — leaving every container member
 *                          undeclared rather than permissive.
 * @param opts.projections  from collectProjections
 * @param opts.strict       declare recovered member types (false = permissive)
 * @param opts.typoDetection  close containers, so unknown members are errors
 * @param opts.maxPasses    override the pass ceiling
 * @returns { text, program, downgrades, converged }
 */
function buildAugmentation(ts, opts) {
  const { rootNames, options, augPath, projections } = opts;
  const strict = opts.strict !== false;
  const typoDetection = !!opts.typoDetection && strict;
  const maxPasses = opts.maxPasses || MAX_GENERATION_PASSES;

  // Two synthetic file kinds live only in memory: the augmentation and each
  // passage projection.
  const synthetic = new Map(); // normalized path -> content
  for (const proj of projections.values()) synthetic.set(norm(proj.virtual), proj.content);
  synthetic.set(norm(augPath), ""); // filled after the first pass

  const allRoots = rootNames.concat([...projections.values()].map((p) => p.virtual), augPath);

  const host = ts.createCompilerHost(options, true);
  const origReadFile = host.readFile.bind(host);
  const origFileExists = host.fileExists.bind(host);
  const origGetSource = host.getSourceFile.bind(host);
  host.readFile = (f) => (synthetic.has(norm(f)) ? synthetic.get(norm(f)) : origReadFile(f));
  host.fileExists = (f) => (synthetic.has(norm(f)) ? true : origFileExists(f));
  // Several Programs are built back to back, and the default host re-reads and
  // re-parses every file per Program. Nothing on disk changes between passes, so
  // cache the parsed SourceFiles; only the augmentation's content differs, and
  // its cache entry is keyed on content so each pass re-parses exactly that one
  // file.
  //
  // Keyed by the EXACT file name, not norm(): norm lowercases, and on a
  // case-sensitive filesystem two real files differing only in case would
  // collapse into one cache entry — the second would be served the first's
  // SourceFile under the wrong name and never actually parsed.
  const sourceCache = new Map(); // exact path -> { content, sf }
  host.getSourceFile = (fileName, langVersion, onError, shouldCreate) => {
    const content = synthetic.has(norm(fileName)) ? synthetic.get(norm(fileName)) : null;
    const hit = sourceCache.get(fileName);
    if (hit && hit.content === content) return hit.sf;
    const sf =
      content !== null
        ? ts.createSourceFile(fileName, content, langVersion, true)
        : origGetSource(fileName, langVersion, onError, shouldCreate);
    if (sf) sourceCache.set(fileName, { content, sf });
    return sf;
  };

  const { createAnalyzer } = require("./analyzer.js");
  const analyzer = createAnalyzer(ts);

  let program = ts.createProgram(allRoots, options, host);
  let converged = false;
  // Only the settled pass's downgrades are real: an early pass sees members that
  // later passes go on to type, so reporting from one would warn about types
  // that recovery was still in the middle of resolving.
  let downgrades = [];
  for (let pass = 0; pass < maxPasses; pass++) {
    const pending = [];
    const next = analyzer.generate(program, augPath, strict, typoDetection, projections, strict ? pending : null);
    downgrades = pending;
    if (next === synthetic.get(norm(augPath))) {
      converged = true;
      break;
    }
    synthetic.set(norm(augPath), next);
    program = ts.createProgram(allRoots, options, host);
  }

  return { text: synthetic.get(norm(augPath)), program, downgrades, converged };
}

module.exports = { collectProjections, buildAugmentation, MAX_GENERATION_PASSES };
