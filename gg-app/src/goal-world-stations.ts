// The places in a Goal's world, named by what happens there, and which kind
// of work sends a critter to each. Geometry-free: the farm map decides where
// each one actually is.

import type { WorkKind } from "./goal-world-agents";

export const STATION_KINDS = [
  "door",
  "workbench",
  "machine",
  "bookcase",
  "maptable",
  "computer",
  "whiteboard",
  "mailbox",
  "lounge",
] as const;
export type StationKind = (typeof STATION_KINDS)[number];

/**
 * Where each kind of work happens. On the farm: the gate is the door, the
 * carpenter's bench the workbench, the stove the machine, the fishing spot
 * the map table (searching is fishing), the laptop the computer, the notes
 * board the whiteboard, the post box the mailbox, and the tea bench by the
 * fire the lounge.
 */
export const STATION_FOR: Readonly<Record<WorkKind, StationKind>> = {
  read: "bookcase",
  search: "maptable",
  edit: "workbench",
  run: "machine",
  web: "computer",
  think: "whiteboard",
  ask: "mailbox",
  delegate: "door",
  wait: "lounge",
};
