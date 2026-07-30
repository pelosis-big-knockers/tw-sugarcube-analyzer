# tw-sugarcube-analyzer

Shared analysis core for SugarCube's author-populated containers — `setup`,
`State.variables`, `State.temporary`, `settings`.

Those interfaces ship empty from `@types/twine-sugarcube`, because a story
creates their members by plain assignment:

```ts
setup.COLORS = ["red", "green", "blue"] as const;
setup.attack = (power: number): number => power * 2;
```

This package recovers each member's type from those assignments and emits a
`declare module "twine-sugarcube"` augmentation, so the members are typed
instead of `any`. It also projects `.twee` passages to TypeScript, so
`<<set $hp to 10>>` contributes to that recovery like any other assignment.

## Why it's its own package

It has three consumers that must not drift apart:

| Consumer | What it does with the augmentation |
| --- | --- |
| `tw-sugarcube-ts-tools` — language-service plugin | feeds it to tsserver for hover, completion, go-to-definition, diagnostics |
| `tw-sugarcube-ts-tools` — `bin/lint.js` | type-checks the whole project against it in CI |
| `tw-server` | writes it to disk for the build's `tsc` type-check |

When these disagree, the editor reports code as correct that the build rejects
(or the reverse), and an author has no way to tell which one is lying.

## API

```js
const { createAnalyzer } = require("tw-sugarcube-analyzer/analyzer.js");
const { collectProjections, buildAugmentation } = require("tw-sugarcube-analyzer/augmentation.js");
const twee = require("tw-sugarcube-analyzer/twee.js");
```

`ts` is always a **parameter**, never an import:

- the language-service plugin must use the TypeScript instance tsserver injected
  into it, not one it resolves itself;
- callers on the TypeScript 7.x native line have to supply a 5.x/6.x instance,
  because the native compiler exposes no in-process `createProgram`.

### `buildAugmentation(ts, opts)`

Drives `createAnalyzer(ts).generate` to a fixed point and returns
`{ text, program, downgrades, converged }`. One pass is not enough — a recovered
member type can depend on a previously recovered one — and re-implementing that
loop per consumer is exactly how they drift.

`opts.augPath` **must be inside the project tree**. The augmentation's
`import "twine-sugarcube"` resolves relative to that path; from anywhere else
the module doesn't resolve and the whole augmentation is silently dropped,
leaving every container member undeclared rather than permissive.

### `collectProjections(root, onWarn?)`

Every `.twee` under `root`, projected to TypeScript, keyed for
`buildAugmentation`. Each entry keeps its source text so consumers can map
diagnostics back onto the `.twee` document.

## License

GPL-3.0-or-later, inherited from `tw-sugarcube-ts-tools`, where this code
originated — and matching both consumers, which are GPL-3.0-or-later too.
