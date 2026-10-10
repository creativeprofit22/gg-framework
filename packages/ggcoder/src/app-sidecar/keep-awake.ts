import { KeepAwake } from "../core/keep-awake.js";

/** App-wide idle-sleep guard: every window's runs share one OS assertion. The
 *  `keepAwake` setting is applied at daemon start and live via /keep-awake. */
export const keepAwake = new KeepAwake();
