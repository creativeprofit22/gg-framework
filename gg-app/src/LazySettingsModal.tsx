import { lazy, Suspense, type ComponentProps } from "react";

// Settings only opens on request, so it and its Azure/Appearance panels stay
// out of the startup bundle and load the first time the modal mounts.
const SettingsModalImpl = lazy(() =>
  import("./SettingsModal").then((module) => ({ default: module.SettingsModal })),
);

export function SettingsModal(props: ComponentProps<typeof SettingsModalImpl>): React.ReactElement {
  return (
    <Suspense fallback={null}>
      <SettingsModalImpl {...props} />
    </Suspense>
  );
}
