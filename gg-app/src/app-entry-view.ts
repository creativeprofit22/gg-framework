export type EntryView = "home" | "projects" | "chats" | "login";

/** New windows always start at Home; workspace restore may replace this after boot. */
export function initialEntryView(_isSecondaryWindow: boolean): EntryView {
  return "home";
}
