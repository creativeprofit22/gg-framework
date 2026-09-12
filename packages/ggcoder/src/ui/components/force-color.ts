/**
 * Side effect, imported first by themed-output.test.tsx: force chalk (used by
 * Ink for colors) to truecolor level. Chalk computes its level from the
 * environment at module-evaluation time, and vitest workers are not TTYs, so
 * without this every component renders uncolored and the theme assertions
 * would have nothing to observe. Import order in the test file guarantees this
 * module evaluates before ink pulls in chalk.
 */
process.env.FORCE_COLOR = "3";

export {};
