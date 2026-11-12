import { CHANGELOG } from "../src/changelog";
import { LOCAL_CHANGELOG } from "../src/local-changelog";

// Build/test configuration only: histories remain the authoritative head source.
export const whatsNewHeadDefines = {
  __WHATS_NEW_HEADS__: JSON.stringify({
    local: LOCAL_CHANGELOG.find(({ items }) => items.length > 0)?.id,
    upstream: CHANGELOG.find(({ items }) => items.length > 0)?.version,
  }),
};
