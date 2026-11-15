// Compiled by tsconfig.browser.json alone, never bundled and never run.
// That config names no Node types, because the code it checks runs in a browser.
// Naming none is not enough to keep them out: a declaration file that asks for them
// (a dependency's `/// <reference types="node" />`, an import of a package typed
// against Node) brings `process` and `Buffer` back for every file, and the pass
// would go on succeeding. Each statement below must stay an error: the day one
// compiles, its directive is reported as unused (TS2578) and the typecheck fails
// HERE, not where the types came in.
//
// When that happens, find what brought them in, from this package's folder:
//   pnpm exec tsc --noEmit -p tsconfig.browser.json --explainFiles
// and read the reasons listed under `@types/node/index.d.ts`: they name the file
// that asked for the types. Then keep that import or dependency out of the code this
// config checks. If Node's types cannot be kept out any more, replace this pass by a
// lint rule on the same names; never silence this file.
//
// An editor that opens this file outside that config may report both directives as
// unused: `pnpm typecheck` is what decides.

// @ts-expect-error Node's `process` is not declared for code that runs in a browser
void process;

// @ts-expect-error Node's `Buffer` is not declared for code that runs in a browser
void Buffer;

export {};
