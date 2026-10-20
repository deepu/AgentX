/**
 * @memwise/policy: policy layers, the compiler and effective policy (docs/memwise/08-policy-and-control.md §2).
 *
 * Pure functions, no I/O. See README.md for what this package owns and which packages it may
 * depend on.
 */

export * from './types.ts';
export { BUILTIN_TOOLS, PLATFORM_DEFAULTS, VERIFIER_ROLE, layersFor, mergeStricter, stepLayer, type LayersForInput } from './layers.ts';
export { compilePolicy } from './compile.ts';
export { decide } from './decide.ts';
export { describePolicy, violationsToDiagnostics } from './describe.ts';
