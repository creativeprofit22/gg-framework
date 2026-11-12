// Retries hide whether a failure reproduces, so only CI retries by default.
// Add a tag name here, then tag the flaky test with it (`{ tags: [name] }`), to retry it once locally.
export const LOCAL_FLAKY_NAMES = [];

export function isCi(env = process.env) {
  return [env.CI, env.CONTINUOUS_INTEGRATION].some(
    (value) => value !== undefined && value !== "" && value !== "false" && value !== "0",
  );
}

export function retryCount({ ci, name, flakyNames = [] }) {
  if (ci) return 2;
  return flakyNames.includes(name) ? 1 : 0;
}
