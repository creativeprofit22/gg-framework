import { useCallback, useEffect, useRef } from "react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getDroppedPathInfo, readDroppedFileAttachment } from "./agent";
import { attachmentToPending, type PendingAttachment } from "./attachments";

// A drag that stops delivering events for this long is over: the platform
// swallowed the terminal leave/drop (see the drag-overlay watchdog below).
const STALE_DRAG_OVERLAY_MS = 2_500;

function hasDraggedFiles(dataTransfer: DataTransfer | null): boolean {
  return Array.from(dataTransfer?.types ?? []).includes("Files");
}

type WebkitEntry = { isDirectory?: boolean };
type DirectoryAwareDataTransferItem = DataTransferItem & {
  webkitGetAsEntry?: () => WebkitEntry | null;
};

function isDirectoryDragItem(item: DataTransferItem): boolean {
  const entry = (item as DirectoryAwareDataTransferItem).webkitGetAsEntry?.();
  return entry?.isDirectory === true;
}

function filesForAttachment(dataTransfer: DataTransfer): File[] {
  const items = Array.from(dataTransfer.items ?? []);
  if (items.length === 0) return Array.from(dataTransfer.files);
  return items
    .filter((item) => item.kind === "file" && !isDirectoryDragItem(item))
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null);
}

function canHandleWindowFileDrop(): boolean {
  return !document.querySelector(".modal-backdrop");
}

/** Drag-over overlay flag setter with a stale-drag watchdog. Extracted from App.tsx. */
export function useDragOverlay({
  isFileDragOver,
  setIsFileDragOver,
}: {
  isFileDragOver: boolean;
  setIsFileDragOver: Dispatch<SetStateAction<boolean>>;
}): (active: boolean) => void {
  // The "Drop files to attach" overlay must never outlive the drag. macOS keeps
  // Tauri's native drag-drop handler (so folder drops carry a real path), and
  // that handler can swallow the terminal `leave`/`drop` event — a drag that is
  // cancelled, or released where the webview refuses the drop, then pinned the
  // overlay to the screen forever. So: every drag event re-arms a watchdog, and
  // any real pointer/key input clears a stale overlay (no pointer or key events
  // are delivered while a drag session is actually in flight).
  const dragWatchdogRef = useRef<number | null>(null);
  const setDragOverActive = useCallback(
    (active: boolean): void => {
      setIsFileDragOver(active);
      if (dragWatchdogRef.current !== null) window.clearTimeout(dragWatchdogRef.current);
      dragWatchdogRef.current = active
        ? window.setTimeout(() => setIsFileDragOver(false), STALE_DRAG_OVERLAY_MS)
        : null;
    },
    [setIsFileDragOver],
  );

  useEffect(() => {
    if (!isFileDragOver) return;
    const clear = (): void => setDragOverActive(false);
    const events = ["pointermove", "pointerdown", "keydown", "blur"] as const;
    for (const name of events) window.addEventListener(name, clear);
    return () => {
      for (const name of events) window.removeEventListener(name, clear);
    };
  }, [isFileDragOver, setDragOverActive]);

  return setDragOverActive;
}

/**
 * Whole-window file drop: blocks browser navigation on stray drops, stages
 * native Tauri drops (folders become paths in the draft), and returns the
 * React drag handlers for the app root. Extracted from App.tsx.
 */
export function useWindowFileDrop({
  setDragOverActive,
  stageAttachments,
  attachmentGenerationRef,
  insertDroppedFolderPaths,
  addFiles,
}: {
  setDragOverActive: (active: boolean) => void;
  stageAttachments: (read: () => Promise<(PendingAttachment | null)[]>) => Promise<void>;
  attachmentGenerationRef: MutableRefObject<number>;
  insertDroppedFolderPaths: (paths: string[]) => void;
  addFiles: (files: FileList | File[]) => Promise<void>;
}) {
  // Stop the browser from navigating to / opening a file dropped anywhere
  // (which would replace the whole UI with the raw file). The active chat view
  // handles files as attachments; native Tauri drop events add folder paths to
  // the draft because browser File objects cannot represent directories well.
  useEffect(() => {
    const prevent = (e: DragEvent): void => {
      // Only files — don't interfere with text selection drags.
      if (hasDraggedFiles(e.dataTransfer)) e.preventDefault();
    };
    window.addEventListener("dragover", prevent);
    window.addEventListener("drop", prevent);
    return () => {
      window.removeEventListener("dragover", prevent);
      window.removeEventListener("drop", prevent);
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void getCurrentWebview()
      .onDragDropEvent((event) => {
        if (disposed) return;
        const payload = event.payload;
        if (payload.type === "enter" || payload.type === "over") {
          if (canHandleWindowFileDrop()) setDragOverActive(true);
          return;
        }
        if (payload.type === "leave") {
          setDragOverActive(false);
          return;
        }
        setDragOverActive(false);
        if (!canHandleWindowFileDrop() || payload.paths.length === 0) return;
        const generation = attachmentGenerationRef.current;
        void stageAttachments(async () => {
          const infos = await getDroppedPathInfo(payload.paths);
          if (disposed || generation !== attachmentGenerationRef.current) return [];
          insertDroppedFolderPaths(infos.filter((info) => info.isDir).map((info) => info.path));
          const filePaths = infos.filter((info) => !info.isDir).map((info) => info.path);
          return Promise.all(
            filePaths.map(async (path): Promise<PendingAttachment | null> => {
              const attachment = await readDroppedFileAttachment(path);
              return attachment ? attachmentToPending(attachment) : null;
            }),
          );
        });
      })
      .then((off) => {
        if (disposed) off();
        else unlisten = off;
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [insertDroppedFolderPaths, setDragOverActive, stageAttachments, attachmentGenerationRef]);

  function handleWindowDragEnter(e: React.DragEvent<HTMLDivElement>): void {
    if (!hasDraggedFiles(e.dataTransfer) || !canHandleWindowFileDrop()) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    setDragOverActive(true);
  }

  function handleWindowDragOver(e: React.DragEvent<HTMLDivElement>): void {
    if (!hasDraggedFiles(e.dataTransfer) || !canHandleWindowFileDrop()) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    setDragOverActive(true);
  }

  function handleWindowDragLeave(e: React.DragEvent<HTMLDivElement>): void {
    if (!hasDraggedFiles(e.dataTransfer)) return;
    const nextTarget = e.relatedTarget;
    if (nextTarget instanceof Node && e.currentTarget.contains(nextTarget)) return;
    setDragOverActive(false);
  }

  function handleWindowDrop(e: React.DragEvent<HTMLDivElement>): void {
    if (!hasDraggedFiles(e.dataTransfer)) return;
    e.preventDefault();
    setDragOverActive(false);
    if (!canHandleWindowFileDrop()) return;
    const files = filesForAttachment(e.dataTransfer);
    if (files.length > 0) void addFiles(files);
  }

  return { handleWindowDragEnter, handleWindowDragOver, handleWindowDragLeave, handleWindowDrop };
}
