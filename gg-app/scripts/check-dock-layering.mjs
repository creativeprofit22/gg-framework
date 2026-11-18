import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

/*
 * Build gate: surfaces the user must see or act on stay inside the pane's
 * floating dock.
 *
 * Since upstream 0.91 the dock (`.app > .dock`, Deck.css) is absolutely
 * positioned over the bottom of the conversation and paints above it. Anything
 * rendered as an in-flow sibling below the conversation lands underneath the
 * dock and disappears. That is how the plan-approval and Roadmap review dock
 * vanished after the upstream merge while the composer stayed locked. jsdom
 * tests can't see stacking, so this reads AgentPane's JSX instead:
 *
 * 1. Required surfaces (review dock, Roadmap refresh recovery, update banners)
 *    must be rendered inside the dock.
 * 2. The dock's parent may hold only the conversation stack and the dock.
 * 3. Every other child of the pane root must be known not to occupy the bottom
 *    of the pane: portalled/fixed modals and toasts, visually hidden live
 *    regions, or the overlays listed below. A new root child fails the build
 *    until someone confirms where it renders and lists it here.
 */

const here = dirname(fileURLToPath(import.meta.url));
export const defaultTarget = resolve(here, "../src/AgentPane.tsx");

/** Must be rendered inside the floating dock. */
export const requiredInDock = [
  { label: "plan/Roadmap review dock (<ReviewDock>)", matches: (el) => el.tag === "ReviewDock" },
  {
    label: "Roadmap refresh recovery (.roadmap-draft-refresh-error)",
    matches: (el) => el.classes.includes("roadmap-draft-refresh-error"),
  },
  {
    label: "update banner (.update-banner)",
    matches: (el) => el.classes.includes("update-banner") || el.tag === "UpdateBanner",
  },
];

/** Children of the dock's parent that may sit beside the dock. */
const allowedDockSiblings = [(el) => el.classes.includes("conversation-stack")];

/**
 * Direct children of the pane root known not to sit in the dock's band:
 * the header and goal world are positioned/fill regions, modals and toasts
 * portal or use fixed positioning, and visually hidden nodes take no space.
 */
const allowedRootChildren = [
  (el) => el.tag === "Activity",
  (el) => el.tag === "WorkspaceHeader",
  (el) => el.tag === "Confetti",
  (el) => el.tag === "Toaster",
  (el) => /Modal$/.test(el.tag),
  (el) => el.classes.includes("visually-hidden") || el.classes.includes("sr-only"),
];

function attr(node, name) {
  const attributes = ts.isJsxElement(node)
    ? node.openingElement.attributes
    : ts.isJsxSelfClosingElement(node)
      ? node.attributes
      : null;
  return attributes?.properties.find(
    (property) => ts.isJsxAttribute(property) && property.name.getText() === name,
  );
}

/** Every literal fragment of a className, including template and conditional parts. */
function classNames(node) {
  const attribute = attr(node, "className");
  if (!attribute?.initializer) return [];
  const words = [];
  const visit = (current) => {
    if (ts.isStringLiteral(current) || ts.isNoSubstitutionTemplateLiteral(current))
      words.push(...current.text.split(/\s+/));
    else if (ts.isTemplateExpression(current)) {
      words.push(...current.head.text.split(/\s+/));
      for (const span of current.templateSpans) {
        visit(span.expression);
        words.push(...span.literal.text.split(/\s+/));
      }
    } else ts.forEachChild(current, visit);
  };
  visit(attribute.initializer);
  return words.filter(Boolean);
}

function tagName(node) {
  if (ts.isJsxElement(node)) return node.openingElement.tagName.getText();
  if (ts.isJsxSelfClosingElement(node)) return node.tagName.getText();
  return "<>";
}

function describe(node, sourceFile) {
  const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return { node, tag: tagName(node), classes: classNames(node), line: line + 1 };
}

const isElement = (node) => ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node);

/**
 * Rendered element children, looking through `{cond && <X/>}`, ternaries,
 * parentheses and fragments — those don't add a DOM box.
 */
function renderedChildren(node, sourceFile) {
  const result = [];
  const visit = (current) => {
    if (isElement(current)) {
      result.push(describe(current, sourceFile));
      return;
    }
    if (ts.isJsxFragment(current)) {
      current.children.forEach(visit);
      return;
    }
    if (ts.isJsxExpression(current)) {
      if (current.expression) visit(current.expression);
      return;
    }
    if (ts.isParenthesizedExpression(current)) return visit(current.expression);
    if (ts.isBinaryExpression(current)) return visit(current.right);
    if (ts.isConditionalExpression(current)) {
      visit(current.whenTrue);
      visit(current.whenFalse);
    }
  };
  if (ts.isJsxElement(node)) node.children.forEach(visit);
  return result;
}

function findAll(root, predicate) {
  const found = [];
  const visit = (node) => {
    if (predicate(node)) found.push(node);
    ts.forEachChild(node, visit);
  };
  visit(root);
  return found;
}

function containedIn(node, container) {
  for (let current = node.parent; current; current = current.parent)
    if (current === container) return true;
  return false;
}

/** Returns human-readable problems; an empty array means the layering is safe. */
export function checkDockLayering(source, fileName = "AgentPane.tsx") {
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const elements = findAll(sourceFile, isElement).map((node) => describe(node, sourceFile));
  const problems = [];
  const at = (el) => `${fileName}:${el.line}`;

  const docks = elements.filter((el) => el.classes.length === 1 && el.classes[0] === "dock");
  if (docks.length !== 1) {
    return [
      `${fileName}: expected exactly one floating dock (className="dock"), found ${docks.length}. ` +
        "If the dock moved or was renamed, update scripts/check-dock-layering.mjs with it.",
    ];
  }
  const [dock] = docks;

  for (const rule of requiredInDock) {
    for (const el of elements.filter(rule.matches)) {
      if (!containedIn(el.node, dock.node))
        problems.push(
          `${at(el)}: ${rule.label} is rendered outside the floating dock (${at(dock)}). ` +
            "The dock paints over the bottom of the pane, so this would be hidden underneath it. " +
            'Render it inside <div className="dock">.',
        );
    }
  }

  let dockParent = dock.node.parent;
  while (dockParent && !isElement(dockParent)) dockParent = dockParent.parent;
  if (dockParent) {
    for (const sibling of renderedChildren(dockParent, sourceFile)) {
      if (sibling.node === dock.node || allowedDockSiblings.some((allow) => allow(sibling)))
        continue;
      problems.push(
        `${at(sibling)}: <${sibling.tag}${sibling.classes.length ? ` className="${sibling.classes.join(" ")}"` : ""}> ` +
          `is a sibling of the floating dock (${at(dock)}) and would be hidden underneath it. ` +
          "Move it inside the dock.",
      );
    }
  }

  const root = elements.find(
    (el) =>
      el.classes.includes("app") &&
      el.classes.includes("agent-pane") &&
      containedIn(dock.node, el.node),
  );
  if (!root) {
    problems.push(
      `${fileName}: could not find the pane root (className "app agent-pane") around the dock.`,
    );
    return problems;
  }
  for (const child of renderedChildren(root.node, sourceFile)) {
    if (allowedRootChildren.some((allow) => allow(child))) continue;
    problems.push(
      `${at(child)}: <${child.tag}${child.classes.length ? ` className="${child.classes.join(" ")}"` : ""}> ` +
        "is a new in-flow child of the pane root. If it renders at the bottom of the pane the floating " +
        "dock covers it: render it inside the dock, or portal it / take it out of flow and list it in " +
        "scripts/check-dock-layering.mjs.",
    );
  }
  return problems;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const target = resolve(process.argv[2] ?? defaultTarget);
  const name = relative(process.cwd(), target) || target;
  const problems = checkDockLayering(readFileSync(target, "utf8"), name);
  if (problems.length > 0) {
    console.error(`Dock layering check failed (${problems.length}):\n- ${problems.join("\n- ")}`);
    process.exit(1);
  }
  console.log(`Dock layering check passed: ${name}`);
}
