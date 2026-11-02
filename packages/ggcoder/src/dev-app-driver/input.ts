export interface InputClient {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
}

/** Bitmask used by Input.dispatchKeyEvent / dispatchMouseEvent. */
export const MODIFIERS = { alt: 1, ctrl: 2, meta: 4, shift: 8 } as const;

export interface KeyDescriptor {
  key: string;
  code: string;
  windowsVirtualKeyCode: number;
}

const NAMED_KEYS: Record<string, KeyDescriptor> = {
  Enter: { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 },
  Tab: { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 },
  Escape: { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
  Backspace: { key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 },
  Delete: { key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 },
  Space: { key: " ", code: "Space", windowsVirtualKeyCode: 32 },
  " ": { key: " ", code: "Space", windowsVirtualKeyCode: 32 },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", windowsVirtualKeyCode: 37 },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", windowsVirtualKeyCode: 38 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 },
  Home: { key: "Home", code: "Home", windowsVirtualKeyCode: 36 },
  End: { key: "End", code: "End", windowsVirtualKeyCode: 35 },
  PageUp: { key: "PageUp", code: "PageUp", windowsVirtualKeyCode: 33 },
  PageDown: { key: "PageDown", code: "PageDown", windowsVirtualKeyCode: 34 },
  "=": { key: "=", code: "Equal", windowsVirtualKeyCode: 187 },
  "-": { key: "-", code: "Minus", windowsVirtualKeyCode: 189 },
  "/": { key: "/", code: "Slash", windowsVirtualKeyCode: 191 },
};

export function resolveKey(name: string): KeyDescriptor {
  const named = NAMED_KEYS[name];
  if (named) return named;
  if (/^[a-z]$/i.test(name)) {
    const upper = name.toUpperCase();
    return { key: name, code: `Key${upper}`, windowsVirtualKeyCode: upper.charCodeAt(0) };
  }
  if (/^[0-9]$/.test(name)) {
    return { key: name, code: `Digit${name}`, windowsVirtualKeyCode: name.charCodeAt(0) };
  }
  throw new RangeError(`Unsupported key: ${JSON.stringify(name)}`);
}

function keyText(descriptor: KeyDescriptor, modifiers: number): string | undefined {
  if (descriptor.key === "Enter") return "\r";
  if (descriptor.key === " ") return " ";
  const commandChord = (modifiers & (MODIFIERS.alt | MODIFIERS.ctrl | MODIFIERS.meta)) !== 0;
  return descriptor.key.length === 1 && !commandChord ? descriptor.key : undefined;
}

/** Trusted key down/up pair; Enter and Space carry text so they activate like a real keyboard. */
export async function pressKey(client: InputClient, name: string, modifiers = 0): Promise<void> {
  const descriptor = resolveKey(name);
  await client.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    ...descriptor,
    modifiers,
    text: keyText(descriptor, modifiers),
  });
  await client.send("Input.dispatchKeyEvent", { type: "keyUp", ...descriptor, modifiers });
}

export async function insertText(client: InputClient, text: string): Promise<void> {
  await client.send("Input.insertText", { text });
}

export interface Point {
  x: number;
  y: number;
}

function assertPoint(point: Point): void {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
    throw new RangeError(`Invalid pointer position: ${JSON.stringify(point)}`);
  }
}

export async function pointerMove(client: InputClient, point: Point): Promise<void> {
  assertPoint(point);
  await client.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
}

export async function pointerPress(client: InputClient, point: Point): Promise<void> {
  assertPoint(point);
  await client.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: point.x,
    y: point.y,
    button: "left",
    buttons: 1,
    clickCount: 1,
  });
}

export async function pointerRelease(client: InputClient, point: Point): Promise<void> {
  assertPoint(point);
  await client.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: point.x,
    y: point.y,
    button: "left",
    buttons: 0,
    clickCount: 1,
  });
}

export async function clickAt(client: InputClient, point: Point): Promise<void> {
  await pointerMove(client, point);
  await pointerPress(client, point);
  await pointerRelease(client, point);
}

/** One trusted mouse-wheel step; positive deltaY scrolls down whatever is under the point. */
export async function wheelAt(client: InputClient, point: Point, deltaY: number): Promise<void> {
  assertPoint(point);
  if (!Number.isFinite(deltaY)) throw new RangeError(`Invalid wheel delta: ${deltaY}`);
  await client.send("Input.dispatchMouseEvent", {
    type: "mouseWheel",
    x: point.x,
    y: point.y,
    deltaX: 0,
    deltaY,
  });
}

export async function captureScreenshot(client: InputClient): Promise<Buffer> {
  const image = await client.send("Page.captureScreenshot", { format: "png" });
  const data =
    typeof image === "object" && image !== null ? (image as { data?: unknown }).data : undefined;
  if (typeof data !== "string") throw new Error("Screenshot returned no image data");
  return Buffer.from(data, "base64");
}
