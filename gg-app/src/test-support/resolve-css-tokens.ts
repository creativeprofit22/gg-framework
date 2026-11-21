// Inlines the px design tokens declared in App.css `:root` (--space-*, --fs-*,
// --radius-*). Static-CSS contract tests keep asserting exact geometry after
// rules moved onto upstream's token scale, and jsdom cannot resolve var().
export function resolvePxTokens(css: string, rootCss: string = css): string {
  const root = /:root\s*\{([^}]*)\}/.exec(rootCss)?.[1] ?? "";
  const px = new Map<string, string>();
  for (const match of root.matchAll(
    /(--(?:space|fs|radius)-[\w-]+)\s*:\s*(\d+(?:\.\d+)?px)\s*;/g,
  )) {
    const [, name, value] = match;
    if (name !== undefined && value !== undefined) px.set(name, value);
  }
  return css.replace(/var\(\s*(--[\w-]+)\s*\)/g, (whole, name: string) => px.get(name) ?? whole);
}
