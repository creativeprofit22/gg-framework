export interface AppBuildInfo {
  localPatched: boolean;
  sourceRoot: string;
  customLabel: string;
}

export const appBuildInfo: AppBuildInfo = {
  localPatched: import.meta.env.VITE_GG_LOCAL_PATCHED === "1",
  sourceRoot: import.meta.env.VITE_GG_SOURCE_ROOT ?? "",
  customLabel: import.meta.env.VITE_GG_CUSTOM_BUILD_LABEL ?? "",
};

export function formatVersionLabel(version: string): string {
  return appBuildInfo.customLabel ? `v${version} · ${appBuildInfo.customLabel}` : `v${version}`;
}
