import { describe, it, expect } from "vitest";
import { chunkFile, bm25Rank, languageForFile, CHUNKABLE_EXTENSIONS } from "./code-retrieval.js";

/** `symbol@startLine` for every chunk — boundaries and names in one assertion. */
function outline(rel: string, source: string): string[] {
  return chunkFile(rel, source).map((c) => `${c.symbol}@${c.startLine}`);
}

describe("language detection", () => {
  it("maps every chunkable extension to a language", () => {
    for (const ext of CHUNKABLE_EXTENSIONS) {
      expect(languageForFile(`a.${ext}`), ext).toBeDefined();
    }
  });

  it("returns nothing for a file it cannot chunk", () => {
    expect(languageForFile("notes.md")).toBeUndefined();
    expect(chunkFile("notes.md", "# heading\n")).toEqual([]);
  });
});

describe("python chunking", () => {
  const source = [
    "import os",
    "",
    "MAX_RETRIES = 3",
    "",
    "",
    "def connect(host):",
    '    """Open a socket."""',
    "    return os.open(host)",
    "",
    "",
    "@dataclass",
    "class Client:",
    "    host: str",
    "",
    "    def send(self, payload):",
    "        return connect(self.host)",
    "",
    "",
    "async def shutdown():",
    "    pass",
    "",
  ].join("\n");

  it("chunks module-level defs, classes and constants", () => {
    expect(outline("client.py", source)).toEqual([
      "MAX_RETRIES@3",
      "connect@6",
      "Client@11",
      "shutdown@19",
    ]);
  });

  it("keeps a decorator with its class and methods inside it", () => {
    const client = chunkFile("client.py", source).find((c) => c.symbol === "Client")!;
    expect(client.text.startsWith("@dataclass")).toBe(true);
    expect(client.text).toContain("def send(self, payload):");
    expect(client.text).not.toContain("async def shutdown");
  });
});

describe("go chunking", () => {
  const source = [
    "package server",
    "",
    "import (",
    '\t"fmt"',
    ")",
    "",
    "const DefaultPort = 8080",
    "",
    "type Widget struct {",
    "\tName string",
    "}",
    "",
    "func (w *Widget) Render() string {",
    '\tif w.Name == "}" {',
    '\t\treturn "brace in a string"',
    "\t}",
    '\treturn fmt.Sprintf("%s", w.Name)',
    "}",
    "",
    "func New() *Widget {",
    "\treturn &Widget{}",
    "}",
    "",
  ].join("\n");

  it("chunks consts, types and funcs including receivers", () => {
    expect(outline("server.go", source)).toEqual([
      "DefaultPort@7",
      "Widget@9",
      "Render@13",
      "New@20",
    ]);
  });

  it("does not let a brace inside a string end the block early", () => {
    const render = chunkFile("server.go", source).find((c) => c.symbol === "Render")!;
    expect(render.text).toContain("fmt.Sprintf");
    expect(render.text.trimEnd().endsWith("}")).toBe(true);
  });
});

describe("rust chunking", () => {
  const source = [
    "use std::fmt;",
    "",
    "pub const LIMIT: usize = 10;",
    "",
    "pub struct Widget {",
    "    name: String,",
    "}",
    "",
    "impl fmt::Display for Widget {",
    "    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {",
    '        write!(f, "{}", self.name)',
    "    }",
    "}",
    "",
    "pub async fn render(widget: &Widget) -> String {",
    "    // a } in a comment must not close the block",
    "    widget.name.clone()",
    "}",
    "",
    "mod tests {",
    "    pub fn helper() -> bool {",
    "        true",
    "    }",
    "}",
    "",
  ].join("\n");

  it("chunks consts, structs, impls and fns, and descends into modules", () => {
    expect(outline("widget.rs", source)).toEqual([
      "LIMIT@3",
      "Widget@5",
      "Widget@9",
      "render@15",
      "helper@21",
    ]);
  });

  it("ignores braces inside comments", () => {
    const render = chunkFile("widget.rs", source).find((c) => c.symbol === "render")!;
    expect(render.text).toContain("widget.name.clone()");
  });
});

describe("java chunking", () => {
  const source = [
    "package com.example;",
    "",
    "import java.util.List;",
    "",
    "public interface Renderer {",
    "    String render();",
    "}",
    "",
    "public final class Widget implements Renderer {",
    "    private final String name;",
    "",
    "    /* a } inside a block comment */",
    "    public String render() {",
    "        return name;",
    "    }",
    "}",
    "",
    "enum Mode { FAST, SLOW }",
    "",
  ].join("\n");

  it("chunks top-level types and keeps members inside them", () => {
    expect(outline("Widget.java", source)).toEqual(["Renderer@5", "Widget@9", "Mode@18"]);
    const widget = chunkFile("Widget.java", source).find((c) => c.symbol === "Widget")!;
    expect(widget.text).toContain("public String render()");
  });
});

describe("c# chunking", () => {
  const source = [
    "using System;",
    "",
    "namespace Example.Widgets",
    "{",
    "    public interface IRenderer",
    "    {",
    "        string Render();",
    "    }",
    "",
    "    public sealed class Widget : IRenderer",
    "    {",
    '        public string Render() => "{}";',
    "    }",
    "}",
    "",
  ].join("\n");

  it("descends into a namespace and chunks the types inside it", () => {
    expect(outline("Widget.cs", source)).toEqual(["IRenderer@5", "Widget@10"]);
  });
});

describe("ranking over mixed languages", () => {
  it("returns whole symbols, not fragments", () => {
    const chunks = [
      ...chunkFile("client.py", "def connect_to_database(dsn):\n    return open(dsn)\n"),
      ...chunkFile("server.go", 'func RenderWidget() string {\n\treturn "x"\n}\n'),
      ...chunkFile("lib.rs", "pub fn parse_config(raw: &str) -> Config {\n    todo!()\n}\n"),
    ];
    const ranked = bm25Rank("connect to the database", chunks, 1);
    expect(ranked).toHaveLength(1);
    expect(ranked[0].symbol).toBe("connect_to_database");
    // Whole symbol: the body came along with the signature.
    expect(ranked[0].text).toContain("return open(dsn)");
  });
});
