import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  GIT_BRANCH_LIST_DEFAULT_LIMIT,
  type GitBranchCreateResponse,
  type GitBranchListOk,
  type GitBranchSwitchResponse,
  type GitLocalBranch,
} from "@kenkaiiii/gg-core/git-branch-contract";
import { checkGitBranchName, createGitBranch, getGitBranches, switchGitBranch } from "./agent";
import { FloatingSurface } from "./FloatingSurface";
import { CaretDownIcon, CheckIcon } from "./phosphor-icons";

/** Recent branches shown without searching; the default branch is pinned above them. */
export const RECENT_BRANCH_LIMIT = 5;
const SEARCH_DELAY_MS = 150;
const NAME_CHECK_DELAY_MS = 250;

export interface SwitcherRow {
  key: string;
  name: string;
  remote: boolean;
  current: boolean;
}

export interface SwitcherSection {
  id: "default" | "recent" | "matches" | "remote";
  label: string;
  rows: SwitcherRow[];
}

function recencyOf(branch: GitLocalBranch): number {
  if (!branch.lastUsedAt) return 0;
  const time = Date.parse(branch.lastUsedAt);
  return Number.isNaN(time) ? 0 : time;
}

/** Idle: pinned default, then up to 5 recent. Searching: every match, plus origin-only branches. */
export function buildBranchSections(list: GitBranchListOk, searching: boolean): SwitcherSection[] {
  const currentName = list.current.name;
  const row = (name: string, remote: boolean): SwitcherRow => ({
    key: `${remote ? "remote" : "local"}:${name}`,
    name,
    remote,
    current: !remote && name === currentName,
  });
  const byRecent = [...list.local].sort((a, b) => recencyOf(b) - recencyOf(a));
  if (searching) {
    return [
      { id: "matches" as const, label: "Branches", rows: byRecent.map((b) => row(b.name, false)) },
      {
        id: "remote" as const,
        label: "On GitHub only",
        rows: list.remoteOnly.map((b) => row(b.name, true)),
      },
    ].filter((section) => section.rows.length > 0);
  }
  const defaultName = list.defaultBranch?.name ?? null;
  const pinned = byRecent.filter((b) => b.name === defaultName).slice(0, 1);
  const recent = byRecent.filter((b) => b.name !== defaultName).slice(0, RECENT_BRANCH_LIMIT);
  return [
    { id: "default" as const, label: "Default", rows: pinned.map((b) => row(b.name, false)) },
    { id: "recent" as const, label: "Recent", rows: recent.map((b) => row(b.name, false)) },
  ].filter((section) => section.rows.length > 0);
}

export type Listing =
  | { status: "loading" }
  | { status: "ready"; data: GitBranchListOk }
  | { status: "not-a-repo" }
  | { status: "failed" };

/** The daemon's live answer for a typed name; `unknown` means the check call itself failed. */
export type NameCheck =
  | { status: "checking" }
  | { status: "available" }
  | { status: "invalid"; reason: string }
  | { status: "taken"; reason: string }
  | { status: "unknown" };

/** The last row while searching: create the typed name, or switch to the branch it collides with. */
export type CreateRow =
  | {
      kind: "create";
      key: string;
      name: string;
      check: "checking" | "available" | "invalid" | "taken";
      hint: string | null;
      disabled: boolean;
    }
  | { kind: "switch-to"; key: string; name: string; target: SwitcherRow; hint: string };

/** Null unless `listing` is the loaded search for `text` and no branch in it is named exactly `text`. */
export function createRowFor(listing: Listing, text: string, check: NameCheck): CreateRow | null {
  const name = text.trim();
  if (!name || listing.status !== "ready") return null;
  const { data } = listing;
  if (data.local.some((b) => b.name === name) || data.remoteOnly.some((b) => b.name === name)) {
    return null;
  }
  const key = `create:${name}`;
  switch (check.status) {
    case "invalid":
      return { kind: "create", key, name, check: "invalid", hint: check.reason, disabled: true };
    case "taken": {
      // Case-insensitive filesystems refuse "Main" beside "main": offer the existing branch instead.
      const lower = name.toLowerCase();
      const match = data.local.find((b) => b.name.toLowerCase() === lower);
      if (!match) {
        return { kind: "create", key, name, check: "taken", hint: check.reason, disabled: true };
      }
      return {
        kind: "switch-to",
        key,
        name: match.name,
        target: {
          key: `local:${match.name}`,
          name: match.name,
          remote: false,
          current: match.name === data.current.name,
        },
        hint: check.reason,
      };
    }
    case "checking":
      return {
        kind: "create",
        key,
        name,
        check: "checking",
        hint: "Checking name…",
        disabled: false,
      };
    default:
      // Available, or the check itself failed: the daemon checks again on create.
      return { kind: "create", key, name, check: "available", hint: null, disabled: false };
  }
}

type Outcome =
  | { kind: "none" }
  | { kind: "switching"; name: string }
  | { kind: "creating"; name: string }
  | {
      kind: "conflict";
      action: "switch" | "create";
      name: string;
      reason: string;
      files: string[];
      filesTruncated: boolean;
    }
  | { kind: "busy"; action: "switch" | "create"; name: string; reason: string }
  | { kind: "error"; name: string; message: string }
  | { kind: "create-failed"; name: string; message: string };

interface Props {
  /** The checked-out branch; shown on the trigger and marked in the list. */
  branch: string;
  /** The pane whose project is listed and switched; each pane may open its own folder. */
  paneId: string;
  /** An agent is working in this project: switching and creating are paused. */
  running: boolean;
  /** Runs `/commit` in the chat; offered from the clash error when present. */
  onCommitFirst?: () => void;
  /** A switch or create succeeded: the Git panel should re-read its changes. */
  onSwitched: () => void;
}

/**
 * The branch name in the Git panel heading, as a button that opens a
 * searchable branch list. Follows the Dropdown/CommandPalette combobox
 * pattern: focus stays in the search box and arrows move the highlight through
 * `aria-activedescendant`. Escape closes and returns focus to the trigger.
 * Switching is a plain, never-forced switch in the daemon; a clash is shown,
 * never overwritten. A typed name that matches no branch can be created.
 */
export function BranchSwitcher({
  branch,
  paneId,
  running,
  onCommitFirst,
  onSwitched,
}: Props): React.ReactElement {
  const baseId = useId();
  const listId = `${baseId}-list`;
  const noticeId = `${baseId}-notice`;
  const createGroupId = `${baseId}-create`;
  const createHintId = `${baseId}-create-hint`;
  const optionId = (index: number): string => `${baseId}-option-${index}`;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const [loaded, setLoaded] = useState<{ key: string; listing: Listing } | null>(null);
  const [checked, setChecked] = useState<{ key: string; check: NameCheck } | null>(null);
  const [outcome, setOutcome] = useState<Outcome>({ kind: "none" });
  const rootRef = useRef<HTMLSpanElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const outcomeRef = useRef<HTMLDivElement>(null);
  const requestId = useRef(0);
  const checkRequestId = useRef(0);

  const key = query.trim();
  const searching = key.length > 0;
  const listing = useMemo<Listing>(
    () => (open && loaded && loaded.key === key ? loaded.listing : { status: "loading" }),
    [open, loaded, key],
  );

  // Each query (and each retry) gets a fresh request; only the newest one may land.
  useEffect(() => {
    if (!open) return;
    const id = ++requestId.current;
    const timer = window.setTimeout(
      () => {
        getGitBranches(key ? { query: key, paneId } : { paneId }).then(
          (response) => {
            if (id !== requestId.current) return;
            setLoaded({
              key,
              listing:
                response.status === "ok"
                  ? { status: "ready", data: response }
                  : { status: "not-a-repo" },
            });
          },
          () => {
            if (id === requestId.current) setLoaded({ key, listing: { status: "failed" } });
          },
        );
      },
      key ? SEARCH_DELAY_MS : 0,
    );
    return () => window.clearTimeout(timer);
  }, [open, key, attempt, paneId]);

  // The typed name is checked separately from the list; only the newest answer counts.
  useEffect(() => {
    if (!open || !key) return;
    const id = ++checkRequestId.current;
    const timer = window.setTimeout(() => {
      checkGitBranchName({ branch: key, paneId }).then(
        (response) => {
          if (id !== checkRequestId.current) return;
          const check: NameCheck =
            response.status === "invalid" || response.status === "taken"
              ? { status: response.status, reason: response.reason }
              : response.status === "available"
                ? { status: "available" }
                : { status: "unknown" };
          setChecked({ key, check });
        },
        () => {
          if (id === checkRequestId.current) setChecked({ key, check: { status: "unknown" } });
        },
      );
    }, NAME_CHECK_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [open, key, paneId]);

  const sections = useMemo(
    () => (listing.status === "ready" ? buildBranchSections(listing.data, searching) : []),
    [listing, searching],
  );
  const branchRows = useMemo(() => sections.flatMap((section) => section.rows), [sections]);
  const nameCheck = useMemo<NameCheck>(
    () => (checked && checked.key === key ? checked.check : { status: "checking" }),
    [checked, key],
  );
  const createRow = useMemo(
    () => (searching ? createRowFor(listing, key, nameCheck) : null),
    [searching, listing, key, nameCheck],
  );
  const options = useMemo<(SwitcherRow | CreateRow)[]>(
    () => (createRow ? [...branchRows, createRow] : branchRows),
    [branchRows, createRow],
  );
  const createIndex = createRow ? options.length - 1 : -1;
  const rowsPaused = running || outcome.kind === "switching" || outcome.kind === "creating";
  // The state the menu is showing, exposed as data-state for probes and tests.
  const menuState =
    outcome.kind !== "none"
      ? outcome.kind
      : listing.status === "failed"
        ? "error"
        : listing.status === "ready"
          ? options.length === 0
            ? "empty"
            : running
              ? "paused"
              : "ready"
          : listing.status;
  const active = options.length > 0 ? Math.min(activeIndex, options.length - 1) : -1;
  const activeId = active >= 0 ? optionId(active) : undefined;

  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => inputRef.current?.focus());
    const closeOnOutsidePress = (event: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    // Registered on the next tick so the click that opened the menu doesn't close it.
    const listenerId = window.setTimeout(
      () => document.addEventListener("mousedown", closeOnOutsidePress),
      0,
    );
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(listenerId);
      document.removeEventListener("mousedown", closeOnOutsidePress);
    };
  }, [open]);

  useEffect(() => {
    if (
      outcome.kind === "conflict" ||
      outcome.kind === "busy" ||
      outcome.kind === "error" ||
      outcome.kind === "create-failed"
    ) {
      outcomeRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    } else if (outcome.kind === "none") {
      // Back from a panel: the search box, still holding the typed text, takes focus again.
      inputRef.current?.focus();
    }
  }, [outcome.kind]);

  useEffect(() => {
    if (!activeId) return;
    document.getElementById(activeId)?.scrollIntoView?.({ block: "nearest" });
  }, [activeId]);

  function openMenu(): void {
    setQuery("");
    setActiveIndex(0);
    setLoaded(null);
    setChecked(null);
    setOutcome({ kind: "none" });
    setOpen(true);
  }

  function closeMenu(returnFocus = true): void {
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus();
  }

  async function choose(row: SwitcherRow): Promise<void> {
    if (rowsPaused) return;
    if (row.current) {
      closeMenu();
      return;
    }
    setOutcome({ kind: "switching", name: row.name });
    let response: GitBranchSwitchResponse;
    try {
      response = await switchGitBranch({ branch: row.name, paneId });
    } catch (error) {
      setOutcome({
        kind: "error",
        name: row.name,
        message: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    switch (response.status) {
      case "switched":
        onSwitched();
        closeMenu();
        return;
      case "unchanged":
        closeMenu();
        return;
      case "conflict":
        setOutcome({
          kind: "conflict",
          action: "switch",
          name: row.name,
          reason: response.reason,
          files: response.files,
          filesTruncated: response.filesTruncated,
        });
        return;
      case "busy":
        setOutcome({ kind: "busy", action: "switch", name: row.name, reason: response.reason });
        return;
      case "not-found":
        // The branch vanished since the list was read: show the reason and re-read the list.
        setOutcome({ kind: "error", name: row.name, message: response.reason });
        setLoaded(null);
        setAttempt((n) => n + 1);
        return;
      case "not-a-repo":
        setOutcome({
          kind: "error",
          name: row.name,
          message: "This folder isn't a git repository.",
        });
        return;
      default:
    }
  }

  async function create(name: string): Promise<void> {
    if (running) return;
    setOutcome({ kind: "creating", name });
    let response: GitBranchCreateResponse;
    try {
      response = await createGitBranch({ branch: name, paneId });
    } catch (error) {
      setOutcome({
        kind: "create-failed",
        name,
        message: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    switch (response.status) {
      case "created":
        onSwitched();
        closeMenu();
        return;
      case "invalid":
      case "taken":
        // Back to the list with the reason on the row; a check still in flight can't undo it.
        checkRequestId.current += 1;
        setChecked({ key: name, check: { status: response.status, reason: response.reason } });
        setOutcome({ kind: "none" });
        return;
      case "conflict":
        setOutcome({
          kind: "conflict",
          action: "create",
          name,
          reason: response.reason,
          files: response.files,
          filesTruncated: response.filesTruncated,
        });
        return;
      case "busy":
        setOutcome({ kind: "busy", action: "create", name, reason: response.reason });
        return;
      case "not-a-repo":
        setOutcome({ kind: "create-failed", name, message: "This folder isn't a git repository." });
        return;
      default:
        setOutcome({ kind: "create-failed", name, message: "The app gave an unexpected answer." });
    }
  }

  function chooseOption(option: SwitcherRow | CreateRow): void {
    if (rowsPaused) return;
    if (!("kind" in option)) void choose(option);
    else if (option.kind === "switch-to") void choose(option.target);
    else if (!option.disabled) void create(option.name);
  }

  // Arrows wrap. A disabled create row stays reachable so its reason is read out.
  function step(from: number, direction: 1 | -1): number {
    const count = options.length;
    return (from + direction + count) % count;
  }

  function onInputKeyDown(event: React.KeyboardEvent<HTMLInputElement>): void {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    switch (event.key) {
      case "ArrowDown":
      case "ArrowUp":
        event.preventDefault();
        if (options.length > 0) setActiveIndex(step(active, event.key === "ArrowDown" ? 1 : -1));
        return;
      case "Enter": {
        event.preventDefault();
        const row = options[active];
        if (row) chooseOption(row);
        return;
      }
      case "Tab":
        closeMenu(false);
        return;
      default:
    }
  }

  // Escape anywhere in the menu (search, list or the clash panel) closes just the menu.
  function onMenuKeyDown(event: React.KeyboardEvent<HTMLDivElement>): void {
    if (event.key !== "Escape") return;
    event.preventDefault();
    // Cancel the menu only, never the Git panel or the deck around it.
    event.nativeEvent.stopPropagation();
    closeMenu();
  }

  const notice = running
    ? "Switching and creating branches are paused while an agent works in this project."
    : null;
  const showOutcome =
    outcome.kind === "conflict" ||
    outcome.kind === "busy" ||
    outcome.kind === "error" ||
    outcome.kind === "create-failed";
  const createDisabled = rowsPaused || (createRow?.kind === "create" && createRow.disabled);

  return (
    <span className="branch-switch" ref={rootRef}>
      <h2 className="tool-title branch-switch-title">
        <button
          ref={triggerRef}
          type="button"
          className="branch-switch-trigger"
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          aria-label={`${branch}, switch branch`}
          onClick={() => (open ? closeMenu(false) : openMenu())}
        >
          <span className="branch-switch-name">{branch}</span>
          <CaretDownIcon className="branch-switch-chevron" size={13} aria-hidden="true" />
        </button>
      </h2>
      <FloatingSurface>
        {open && (
          <div
            className="branch-switch-menu"
            data-state={menuState}
            aria-busy={
              listing.status === "loading" ||
              outcome.kind === "switching" ||
              outcome.kind === "creating" ||
              undefined
            }
            onKeyDown={onMenuKeyDown}
          >
            {showOutcome ? (
              <div className="branch-switch-outcome" ref={outcomeRef} role="alert">
                {outcome.kind === "conflict" && (
                  <>
                    {/* `conflict` also covers an unfinished merge or rebase, so the daemon's reason names the cause. */}
                    <p className="branch-switch-outcome-title">
                      {outcome.action === "create"
                        ? `Couldn't create ${outcome.name}. Nothing was changed.`
                        : `Couldn't switch to ${outcome.name}. Nothing was changed.`}
                    </p>
                    <p className="branch-switch-outcome-note">{outcome.reason}</p>
                    {outcome.files.length > 0 && (
                      <ul className="branch-switch-files">
                        {outcome.files.map((file) => (
                          <li key={file} title={file}>
                            {file}
                          </li>
                        ))}
                      </ul>
                    )}
                    {outcome.filesTruncated && (
                      <p className="branch-switch-outcome-note">And more files.</p>
                    )}
                    <div className="branch-switch-actions">
                      {outcome.action === "create" ? (
                        // A refused create switched nothing, so going back keeps the typed name.
                        <button
                          type="button"
                          className="btn-ghost branch-switch-action"
                          onClick={() => setOutcome({ kind: "none" })}
                        >
                          Back to branches
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="btn-ghost branch-switch-action"
                          onClick={() => closeMenu()}
                        >
                          Stay on {branch}
                        </button>
                      )}
                      {onCommitFirst && (
                        <button
                          type="button"
                          className="btn-primary branch-switch-action"
                          onClick={() => {
                            onCommitFirst();
                            closeMenu();
                          }}
                        >
                          Commit first
                        </button>
                      )}
                    </div>
                  </>
                )}
                {outcome.kind === "busy" && (
                  <>
                    <p className="branch-switch-outcome-title">
                      {outcome.action === "create"
                        ? `Couldn't create ${outcome.name}. Nothing was changed.`
                        : "Another chat on this folder is working."}
                    </p>
                    <p className="branch-switch-outcome-note">{outcome.reason}</p>
                    <div className="branch-switch-actions">
                      <button
                        type="button"
                        className="btn-ghost branch-switch-action"
                        onClick={() => setOutcome({ kind: "none" })}
                      >
                        Back to branches
                      </button>
                    </div>
                  </>
                )}
                {outcome.kind === "error" && (
                  <>
                    <p className="branch-switch-outcome-title">
                      Couldn&apos;t switch to {outcome.name}.
                    </p>
                    <p className="branch-switch-outcome-note">{outcome.message}</p>
                    <div className="branch-switch-actions">
                      <button
                        type="button"
                        className="btn-ghost branch-switch-action"
                        onClick={() => setOutcome({ kind: "none" })}
                      >
                        Back to branches
                      </button>
                    </div>
                  </>
                )}
                {outcome.kind === "create-failed" && (
                  <>
                    <p className="branch-switch-outcome-title">
                      Couldn&apos;t create {outcome.name}.
                    </p>
                    <p className="branch-switch-outcome-note">{outcome.message}</p>
                    <div className="branch-switch-actions">
                      <button
                        type="button"
                        className="btn-primary branch-switch-action"
                        onClick={() => void create(outcome.name)}
                      >
                        Retry
                      </button>
                      <button
                        type="button"
                        className="btn-ghost branch-switch-action"
                        onClick={() => setOutcome({ kind: "none" })}
                      >
                        Back to branches
                      </button>
                    </div>
                  </>
                )}
              </div>
            ) : (
              <>
                <div className="branch-switch-search">
                  <input
                    ref={inputRef}
                    type="text"
                    role="combobox"
                    className="branch-switch-input"
                    aria-label="Search branches"
                    placeholder="Search branches"
                    autoComplete="off"
                    spellCheck={false}
                    aria-autocomplete="list"
                    aria-expanded
                    aria-controls={listId}
                    aria-activedescendant={activeId}
                    aria-describedby={notice ? noticeId : undefined}
                    value={query}
                    onChange={(event) => {
                      setQuery(event.target.value);
                      setActiveIndex(0);
                    }}
                    onKeyDown={onInputKeyDown}
                  />
                </div>
                {notice && (
                  <p id={noticeId} className="branch-switch-notice" role="status">
                    {notice}
                  </p>
                )}
                {outcome.kind === "switching" && (
                  <p className="branch-switch-notice" role="status">
                    Switching to {outcome.name}&hellip;
                  </p>
                )}
                {outcome.kind === "creating" && (
                  <p className="branch-switch-notice" role="status">
                    Creating {outcome.name}&hellip;
                  </p>
                )}
                {listing.status === "loading" && (
                  <p className="branch-switch-empty" role="status">
                    {searching ? "Searching…" : "Loading branches…"}
                  </p>
                )}
                {listing.status === "failed" && (
                  <div className="branch-switch-empty">
                    <p>Couldn&apos;t load branches.</p>
                    <button
                      type="button"
                      className="btn-ghost branch-switch-action"
                      onClick={() => {
                        setLoaded(null);
                        setAttempt((n) => n + 1);
                      }}
                    >
                      Retry
                    </button>
                  </div>
                )}
                {listing.status === "not-a-repo" && (
                  <p className="branch-switch-empty">This folder isn&apos;t a git repository.</p>
                )}
                {listing.status === "ready" && branchRows.length === 0 && (
                  <p className="branch-switch-empty">No branches match &ldquo;{key}&rdquo;.</p>
                )}
                {listing.status === "ready" && options.length > 0 && (
                  <div
                    id={listId}
                    className="pop-scroll branch-switch-list"
                    role="listbox"
                    aria-label="Branches"
                    aria-disabled={rowsPaused || undefined}
                  >
                    {sections.map((section) => {
                      const labelId = `${baseId}-${section.id}`;
                      return (
                        <div key={section.id} role="group" aria-labelledby={labelId}>
                          <div id={labelId} className="branch-switch-group">
                            {section.label}
                          </div>
                          {section.rows.map((row) => {
                            const index = options.indexOf(row);
                            return (
                              <button
                                key={row.key}
                                type="button"
                                tabIndex={-1}
                                id={optionId(index)}
                                className={`dropdown-option branch-switch-option${index === active ? " active" : ""}`}
                                role="option"
                                aria-selected={row.current}
                                aria-disabled={rowsPaused || undefined}
                                onMouseDown={(event) => event.preventDefault()}
                                onMouseEnter={() => !rowsPaused && setActiveIndex(index)}
                                onClick={() => chooseOption(row)}
                              >
                                <span className="dropdown-option-text">
                                  <span className="dropdown-option-label">{row.name}</span>
                                </span>
                                {row.current && (
                                  <span className="branch-switch-current">
                                    Current
                                    <CheckIcon
                                      className="dropdown-option-check"
                                      size={14}
                                      aria-hidden="true"
                                    />
                                  </span>
                                )}
                              </button>
                            );
                          })}
                        </div>
                      );
                    })}
                    {createRow && (
                      <div role="group" aria-labelledby={createGroupId}>
                        <div id={createGroupId} className="branch-switch-group">
                          New branch
                        </div>
                        <button
                          key={createRow.key}
                          type="button"
                          tabIndex={-1}
                          id={optionId(createIndex)}
                          className={`dropdown-option branch-switch-option branch-switch-create${createIndex === active ? " active" : ""}`}
                          role="option"
                          aria-selected={false}
                          aria-disabled={createDisabled || undefined}
                          aria-describedby={createRow.hint ? createHintId : undefined}
                          data-check={createRow.kind === "create" ? createRow.check : "taken"}
                          onMouseDown={(event) => event.preventDefault()}
                          onMouseEnter={() => !rowsPaused && setActiveIndex(createIndex)}
                          onClick={() => chooseOption(createRow)}
                        >
                          <span className="dropdown-option-text">
                            <span className="dropdown-option-label branch-switch-create-label">
                              {createRow.kind === "create" ? "Create branch " : "Switch to "}
                              <span className="branch-switch-create-name">
                                &lsquo;{createRow.name}&rsquo;
                              </span>
                            </span>
                            {createRow.hint && (
                              <span id={createHintId} className="branch-switch-create-hint">
                                {createRow.hint}
                              </span>
                            )}
                          </span>
                        </button>
                      </div>
                    )}
                  </div>
                )}
                {listing.status === "ready" && searching && listing.data.truncated && (
                  <p className="branch-switch-note">
                    Showing the first {GIT_BRANCH_LIST_DEFAULT_LIMIT} matches in each list. Type
                    more to narrow the list.
                  </p>
                )}
              </>
            )}
          </div>
        )}
      </FloatingSurface>
    </span>
  );
}
