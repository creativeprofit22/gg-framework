import { createContext, useContext } from "react";
import { createPortal } from "react-dom";

/**
 * Two slots in the Settings screen's header bar, filled by the open page:
 * - status, beside the page's name (the providers' "N connected", Remote's
 *   Live/Off);
 * - actions, right-aligned on the same row (Save, Add, Start serving).
 * The screen renders the empty slot elements and shares them here; a page
 * renders `<SettingsHeaderStatus>` / `<SettingsHeaderAction>`, which portal
 * their children in. A portal rather than lifted state: the page keeps owning
 * its buttons and their handlers, and nothing feeds back into the screen's
 * render. Outside the Settings screen there are no slots and these render
 * nothing, so callers keep their own in-dialog buttons for that case.
 */
export interface SettingsHeaderSlots {
  status: HTMLElement | null;
  actions: HTMLElement | null;
}

const SettingsHeaderContext = createContext<SettingsHeaderSlots | null>(null);

export function SettingsHeaderProvider({
  slots,
  children,
}: {
  slots: SettingsHeaderSlots;
  children: React.ReactNode;
}): React.ReactElement {
  return <SettingsHeaderContext.Provider value={slots}>{children}</SettingsHeaderContext.Provider>;
}

/** Renders `children` beside the page name in the Settings header. */
export function SettingsHeaderStatus({
  children,
}: {
  children: React.ReactNode;
}): React.ReactPortal | null {
  const slot = useContext(SettingsHeaderContext)?.status;
  return slot ? createPortal(children, slot) : null;
}

/** Renders `children` right-aligned in the Settings header. */
export function SettingsHeaderAction({
  children,
}: {
  children: React.ReactNode;
}): React.ReactPortal | null {
  const slot = useContext(SettingsHeaderContext)?.actions;
  return slot ? createPortal(children, slot) : null;
}
