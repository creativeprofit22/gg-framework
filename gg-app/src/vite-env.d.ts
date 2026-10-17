/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Set to `"1"` to build the Local Fork explicitly. */
  readonly VITE_GG_LOCAL_PATCHED?: string;
  /** Repository root used by Local Fork update commands. */
  readonly VITE_GG_SOURCE_ROOT?: string;
  readonly VITE_GG_CUSTOM_BUILD_LABEL?: string;
  /** Required for explicit Local Fork builds when the source commit cannot be derived from Git metadata. */
  readonly VITE_GG_GIT_SHA?: string;
}
