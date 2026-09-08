import { lazy, Suspense, type ComponentProps } from "react";

export { KenPromptActionProvider } from "./ken-prompt-context";

// The home screen needs no parser or syntax grammars. Load them only when
// transcript or plan content mounts, keeping readable text during that load.
const RichMarkdown = lazy(() =>
  import("./Markdown").then((module) => ({ default: module.Markdown })),
);

export function Markdown(props: ComponentProps<typeof RichMarkdown>): React.ReactElement {
  return (
    <Suspense
      fallback={
        <div className="markdown" aria-busy="true" style={{ whiteSpace: "pre-wrap" }}>
          {props.children}
        </div>
      }
    >
      <RichMarkdown {...props} />
    </Suspense>
  );
}
