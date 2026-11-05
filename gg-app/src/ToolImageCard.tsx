import { useEffect, useState } from "react";
import { openProjectPath, readChatImage } from "./agent";
import { basename } from "./tool-format";
import type { TranscriptImage } from "./AgentPane";

interface Loaded {
  path: string;
  url: string | null;
}

export function ToolImageCard({
  image,
  paneId,
  onLoad,
}: {
  image: TranscriptImage;
  paneId: string;
  onLoad?: () => void;
}): React.ReactElement {
  const { path, src } = image;
  // Trimmed images (no src) reload from disk; the data lives only while mounted.
  const reload = src === undefined ? path : undefined;
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [broken, setBroken] = useState<string | null>(null);
  useEffect(() => {
    if (!reload) return;
    let live = true;
    void readChatImage(reload, paneId, "path").then((url) => {
      if (live) setLoaded({ path: reload, url });
    });
    return () => {
      live = false;
    };
  }, [reload, paneId]);

  const url = src ?? (!reload ? null : loaded?.path === reload ? loaded.url : undefined);
  const status =
    url === undefined
      ? "Loading image…"
      : url === null || broken === url
        ? "Image unavailable"
        : null;
  const openImage = (): void => {
    if (path) void openProjectPath(path, paneId);
  };
  return (
    <figure
      className={`img-card${path ? " img-card-clickable" : ""}`}
      role={path ? "button" : undefined}
      tabIndex={path ? 0 : undefined}
      title={path ? `Open ${path}` : undefined}
      onClick={openImage}
      onKeyDown={(e) => {
        if (!path || (e.key !== "Enter" && e.key !== " ")) return;
        e.preventDefault();
        openImage();
      }}
    >
      {status === null && url ? (
        <img
          className="img-thumb"
          src={url}
          alt={path ?? "image"}
          onLoad={onLoad}
          onError={() => setBroken(url)}
        />
      ) : (
        <div className="img-cap" role="status">
          {status}
        </div>
      )}
      {path && (
        <figcaption className="img-cap" title={path}>
          {basename(path)}
        </figcaption>
      )}
    </figure>
  );
}
