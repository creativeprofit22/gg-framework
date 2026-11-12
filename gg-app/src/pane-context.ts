import { createContext } from "react";

// Content belongs to its originating pane, regardless of keyboard focus.
// Standalone/legacy consumers intentionally retain primary-pane behavior.
export const PaneIdContext = createContext("primary");
export const PaneIdProvider = PaneIdContext.Provider;
