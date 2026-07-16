// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsModal } from "./SettingsModal";

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("./agent", () => ({
  getSettings: vi.fn(() => Promise.resolve(null)),
  saveSettings: vi.fn(),
  getPermissionsStatus: vi.fn(() => new Promise(() => {})),
  openPermissionsSettings: vi.fn(),
}));
vi.mock("./build-info", () => ({
  formatBuildIdentity: () => "GG Coder Local Fork · abc1234",
}));
vi.mock("./SoundButton", () => ({ SoundButton: () => <button>Sound</button> }));

afterEach(cleanup);

describe("SettingsModal", () => {
  it("renders the local-build identity in Settings", () => {
    render(<SettingsModal onClose={vi.fn()} />);

    const identity = screen.getByText("GG Coder Local Fork · abc1234");
    expect(identity.className).toBe("modal-build-identity");
  });
});
