import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MobileShell } from "../components/MobileShell";
import type { WorkspacePanelConfig } from "../components/WorkspaceDock";

// Mock matchMedia for useIsMobile hook (if any downstream components use it)
Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});

const mockPanels: WorkspacePanelConfig[] = [
  { id: "chat", title: "Chat", icon: <span data-testid="chat-icon">C</span>, children: <div data-testid="chat-content">ChatContent</div> },
  { id: "preview", title: "Preview", icon: <span data-testid="preview-icon">P</span>, children: <div data-testid="preview-content">PreviewContent</div> },
  { id: "terminal", title: "Terminal", icon: <span data-testid="terminal-icon">T</span>, children: <div data-testid="terminal-content">TerminalContent</div>, onClose: vi.fn() },
];

describe("MobileShell", () => {
  it("shows active panel and hides others", () => {
    render(
      <MobileShell
        panels={mockPanels}
        closedPanels={[]}
        activePanelId="chat"
        onActivatePanel={() => {}}
        onReopenPanel={() => {}}
      />
    );
    const chatContent = screen.getByTestId("chat-content");
    const previewContent = screen.getByTestId("preview-content");
    const terminalContent = screen.getByTestId("terminal-content");

    expect(chatContent.parentElement?.parentElement).not.toHaveClass("hidden");
    expect(previewContent.parentElement?.parentElement).toHaveClass("hidden");
    expect(terminalContent.parentElement?.parentElement).toHaveClass("hidden");
  });

  it("switches tabs", () => {
    const onActivate = vi.fn();
    render(
      <MobileShell
        panels={mockPanels}
        closedPanels={[]}
        activePanelId="chat"
        onActivatePanel={onActivate}
        onReopenPanel={() => {}}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: /Preview/i }));
    expect(onActivate).toHaveBeenCalledWith("preview");
  });

  it("reopens closed panel", () => {
    const onReopen = vi.fn();
    const onActivate = vi.fn();
    render(
      <MobileShell
        panels={mockPanels.slice(0, 2)}
        closedPanels={[mockPanels[2]]}
        activePanelId="chat"
        onActivatePanel={onActivate}
        onReopenPanel={onReopen}
      />
    );
    // Click the overflow "+" button
    fireEvent.click(screen.getByLabelText("Reopen closed panel"));
    // Click the "Terminal" row in the overflow menu
    fireEvent.click(screen.getByRole("button", { name: /Terminal/i }));
    expect(onReopen).toHaveBeenCalledWith("terminal");
    expect(onActivate).toHaveBeenCalledWith("terminal");
  });

  it("renders a close button when onClose is provided", () => {
    render(
      <MobileShell
        panels={mockPanels}
        closedPanels={[]}
        activePanelId="terminal"
        onActivatePanel={() => {}}
        onReopenPanel={() => {}}
      />
    );
    const closeBtn = screen.getByLabelText("Close Terminal");
    expect(closeBtn).toBeInTheDocument();
  });

  it("calls onClose when close button is clicked", () => {
    const onClose = vi.fn();
    const panels = mockPanels.map((p) =>
      p.id === "terminal" ? { ...p, onClose } : p
    );
    render(
      <MobileShell
        panels={panels}
        closedPanels={[]}
        activePanelId="terminal"
        onActivatePanel={() => {}}
        onReopenPanel={() => {}}
      />
    );
    fireEvent.click(screen.getByLabelText("Close Terminal"));
    expect(onClose).toHaveBeenCalled();
  });
});
