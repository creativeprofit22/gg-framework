// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePresenceList } from "./usePresenceList";
import { AttachmentBar } from "./AttachmentBar";
import { ReferencedFiles } from "./ReferencedFiles";
import type { PendingAttachment } from "./attachments";

const EXIT_MS = 220;

function List({ items }: { items: readonly string[] }): React.ReactElement {
  const shown = usePresenceList(items, (s) => s, EXIT_MS);
  return (
    <ul>
      {shown.map((p) => (
        <li key={p.key} data-leaving={p.leaving ? "yes" : "no"}>
          {p.item}
        </li>
      ))}
    </ul>
  );
}

function rows(): string[] {
  return [...document.querySelectorAll("li")].map(
    (li) => `${li.textContent ?? ""}:${li.getAttribute("data-leaving") ?? ""}`,
  );
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("usePresenceList", () => {
  it("renders new items immediately", () => {
    const { rerender } = render(<List items={["a"]} />);
    rerender(<List items={["a", "b"]} />);
    expect(rows()).toEqual(["a:no", "b:no"]);
  });

  it("keeps a removed item in place, marked leaving, until the exit has run", () => {
    const { rerender } = render(<List items={["a", "b", "c"]} />);
    rerender(<List items={["a", "c"]} />);
    expect(rows()).toEqual(["a:no", "b:yes", "c:no"]);

    act(() => {
      vi.advanceTimersByTime(EXIT_MS);
    });
    expect(rows()).toEqual(["a:no", "c:no"]);
  });

  it("revives an item re-added mid-exit instead of duplicating it", () => {
    const { rerender } = render(<List items={["a", "b"]} />);
    rerender(<List items={["a"]} />);
    rerender(<List items={["a", "b"]} />);
    expect(rows()).toEqual(["a:no", "b:no"]);

    act(() => {
      vi.advanceTimersByTime(EXIT_MS * 2);
    });
    expect(rows()).toEqual(["a:no", "b:no"]);
  });

  it("lets every item leave when the list is cleared at once", () => {
    const { rerender } = render(<List items={["a", "b"]} />);
    rerender(<List items={[]} />);
    expect(rows()).toEqual(["a:yes", "b:yes"]);

    act(() => {
      vi.advanceTimersByTime(EXIT_MS);
    });
    expect(rows()).toEqual([]);
  });
});

const PNG: PendingAttachment = {
  id: 1,
  kind: "image",
  name: "shot.png",
  mediaType: "image/png",
  data: "",
  previewUrl: "data:image/png;base64,",
};
const MP4: PendingAttachment = {
  id: 2,
  kind: "video",
  name: "clip.mp4",
  mediaType: "video/mp4",
  data: "",
};

describe("AttachmentBar exit animation", () => {
  it("collapses a removed chip before unmounting it", () => {
    const { rerender } = render(
      <AttachmentBar attachments={[PNG, MP4]} onRemove={vi.fn()} onOpenImage={vi.fn()} />,
    );
    rerender(<AttachmentBar attachments={[MP4]} onRemove={vi.fn()} onOpenImage={vi.fn()} />);

    const leaving = screen.getByTitle("shot.png");
    expect(leaving.className).toContain("leaving");
    expect(document.querySelector(".attach-bar")?.className).not.toContain("leaving");

    act(() => {
      vi.advanceTimersByTime(EXIT_MS);
    });
    expect(screen.queryByTitle("shot.png")).toBeNull();
  });

  it("folds the whole bar shut when the last chip goes (e.g. on send)", () => {
    const { rerender } = render(
      <AttachmentBar attachments={[PNG]} onRemove={vi.fn()} onOpenImage={vi.fn()} />,
    );
    rerender(<AttachmentBar attachments={[]} onRemove={vi.fn()} onOpenImage={vi.fn()} />);
    expect(document.querySelector(".attach-bar")?.className).toContain("leaving");

    act(() => {
      vi.advanceTimersByTime(EXIT_MS);
    });
    expect(document.querySelector(".attach-bar")).toBeNull();
  });

  it("does not let a leaving chip's remove button fire again", () => {
    const onRemove = vi.fn();
    const { rerender } = render(
      <AttachmentBar attachments={[PNG, MP4]} onRemove={onRemove} onOpenImage={vi.fn()} />,
    );
    rerender(<AttachmentBar attachments={[MP4]} onRemove={onRemove} onOpenImage={vi.fn()} />);
    expect(screen.getByTitle("shot.png").hasAttribute("inert")).toBe(true);
    fireEvent.click(screen.getByLabelText("Remove clip.mp4"));
    expect(onRemove).toHaveBeenCalledWith(2);
  });
});

describe("AttachmentBar image chips", () => {
  it("opens an image chip's preview when its thumbnail is clicked", () => {
    const onOpenImage = vi.fn();
    render(<AttachmentBar attachments={[PNG, MP4]} onRemove={vi.fn()} onOpenImage={onOpenImage} />);
    fireEvent.click(screen.getByLabelText("Open shot.png"));
    expect(onOpenImage).toHaveBeenCalledWith(PNG.previewUrl);
    expect(screen.queryByLabelText("Open clip.mp4")).toBeNull();
  });
});

describe("ReferencedFiles exit animation", () => {
  it("keeps a removed @-file chip up while it animates out", () => {
    const { rerender } = render(<ReferencedFiles paths={["src/a.ts"]} onRemove={vi.fn()} />);
    rerender(<ReferencedFiles paths={[]} onRemove={vi.fn()} />);
    expect(screen.getByTitle("src/a.ts").className).toContain("leaving");
    expect(document.querySelector(".mention-bar")?.className).toContain("leaving");

    act(() => {
      vi.advanceTimersByTime(EXIT_MS);
    });
    expect(document.querySelector(".mention-bar")).toBeNull();
  });
});
