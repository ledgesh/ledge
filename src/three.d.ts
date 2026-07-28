// Electrobun's `dist` ships TypeScript source, not compiled output, and one of
// its modules imports `three` for a 3D-window API this app never touches. tsc
// follows that import into node_modules and reports TS7016 there, so
// `tsc --noEmit` exits non-zero on a checkout with nothing wrong with it. That
// is fine to squint past by hand and fatal in CI: the alternatives are a red
// bar on every green change, or a step taught to filter one known error, which
// is a step that will filter the next one too.
//
// The shorthand form types the module as `any` — correct here, because no code
// in this repo reaches it. The alternative is a `@types/three` devDependency
// carried solely to describe an API we never call.
declare module "three";
