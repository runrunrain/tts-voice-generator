import { Outlet, useLocation } from "react-router";
import { NavRail } from "./NavRail";
import { TopBar } from "./TopBar";
import { BottomBar } from "./BottomBar";
import { RightPanel } from "./RightPanel";
import { GlobalAgentDock } from "./GlobalAgentDock";
import { useCallback, useEffect, useState } from "react";
import { TaskWorkspaceUiProvider } from "../context/TaskWorkspaceUiContext";

export function Shell() {
  const [isRightPanelOpen, setIsRightPanelOpen] = useState(true);
  const [isCompactRightPanelOpen, setIsCompactRightPanelOpen] = useState(false);
  const [viewportWidth, setViewportWidth] = useState(() => typeof window === "undefined" ? 1440 : window.innerWidth);
  const [isAgentDockOpen, setIsAgentDockOpen] = useState(false);
  const location = useLocation();
  const toggleAgentDock = useCallback(() => setIsAgentDockOpen((prev) => !prev), []);

  useEffect(() => {
    const handleResize = () => setViewportWidth(window.innerWidth);
    handleResize();
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "a") {
        event.preventDefault();
        toggleAgentDock();
        return;
      }

      if (event.key === "Escape") {
        setIsAgentDockOpen(false);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [toggleAgentDock]);

  // Certain routes hide the right panel completely. /tasks is exact-only so
  // /tasks/:taskId can show the task-scoped Agent inspector in the Shell panel.
  const isHistoryDetail = location.pathname.startsWith("/history/") && location.pathname.split("/").length > 2;
  const isRightPanelHidden = location.pathname === "/tasks" || location.pathname === "/settings" || isHistoryDetail;
  const isCompactLayout = viewportWidth < 1200;
  const rightPanelWidth = viewportWidth >= 1440 ? "clamp(320px, 20vw, 384px)" : "clamp(280px, 22vw, 320px)";
  const gridRightPanelColumn = isRightPanelHidden || isCompactLayout || !isRightPanelOpen ? "0px" : rightPanelWidth;

  const toggleResponsiveRightPanel = () => {
    if (isCompactLayout) {
      setIsCompactRightPanelOpen((prev) => !prev);
      return;
    }
    setIsRightPanelOpen(true);
  };

  const isResponsiveAgentEntryVisible = !isRightPanelHidden && (isCompactLayout || !isRightPanelOpen);
  const responsiveAgentEntry = isResponsiveAgentEntryVisible ? (
    <button
      type="button"
      className="shrink-0 rounded border border-accent/30 bg-bg-elevated px-3 py-1.5 text-xs font-medium text-accent shadow-sm hover:bg-accent-muted focus:outline-none focus:ring-2 focus:ring-accent/40"
      onClick={toggleResponsiveRightPanel}
      aria-expanded={isCompactLayout ? isCompactRightPanelOpen : isRightPanelOpen}
      aria-controls="responsive-agent-panel"
      aria-label={isCompactLayout && isCompactRightPanelOpen ? "关闭 Agent 面板" : "打开 Agent 面板"}
    >
      {isCompactLayout && isCompactRightPanelOpen ? "关闭 Agent 面板" : "打开 Agent 面板"}
    </button>
  ) : null;

  return (
    <div className="h-screen w-screen overflow-hidden bg-bg-base text-text-primary relative">
      <TaskWorkspaceUiProvider>
      <div 
        className="h-full w-full overflow-hidden"
        style={{
          display: "grid",
          gridTemplateColumns: `72px minmax(0, 1fr) ${gridRightPanelColumn}`,
          gridTemplateRows: "48px 1fr 28px",
        }}
      >
      <div className="row-span-3 col-start-1 col-end-2 border-r border-border-subtle bg-bg-base">
        <NavRail isAgentDockOpen={isAgentDockOpen} onToggleAgentDock={toggleAgentDock} />
      </div>

      <div className="col-start-2 col-end-4 row-start-1 row-end-2 border-b border-border-subtle bg-bg-base">
        <TopBar agentPanelSlot={responsiveAgentEntry} />
      </div>

      <div className="col-start-2 col-end-3 row-start-2 row-end-3 min-w-0 min-h-0 overflow-hidden bg-bg-base relative">
        <Outlet />
      </div>

      {!isRightPanelHidden && !isCompactLayout && (
        <div 
          id="responsive-agent-panel"
          className="col-start-3 col-end-4 row-start-2 row-end-3 min-w-0 min-h-0 overflow-hidden bg-bg-elevated border-l border-border-subtle flex flex-col relative"
          style={{ width: isRightPanelOpen ? rightPanelWidth : 0, transition: "width 400ms cubic-bezier(0.4, 0, 0.2, 1)" }}
        >
          {/* Splitter */}
          <div 
            className="absolute left-0 top-0 bottom-0 w-[4px] cursor-col-resize hover:bg-accent/50 active:bg-accent -translate-x-1/2 z-50 transition-colors"
            onDoubleClick={() => setIsRightPanelOpen(!isRightPanelOpen)}
          />
          <div className="flex-1 min-w-0 min-h-0 overflow-hidden">
            <RightPanel isOpen={isRightPanelOpen} onClose={() => setIsRightPanelOpen(false)} />
          </div>
        </div>
      )}

      <div className="col-start-2 col-end-4 row-start-3 row-end-4 bg-bg-sunken border-t border-border-subtle">
        <BottomBar />
      </div>

      {!isRightPanelHidden && isCompactLayout && isCompactRightPanelOpen && (
        <div
          id="responsive-agent-panel"
          className="absolute right-0 top-[48px] bottom-[28px] z-40 w-[min(360px,calc(100vw-72px-24px))] min-w-[300px] max-w-[384px] min-h-0 overflow-hidden border-l border-border-subtle bg-bg-elevated shadow-shadow-lg"
          role="dialog"
          aria-modal="false"
          aria-label="Agent 面板"
        >
          <RightPanel isOpen onClose={() => setIsCompactRightPanelOpen(false)} />
        </div>
      )}

      </div>
      </TaskWorkspaceUiProvider>

      <GlobalAgentDock isOpen={isAgentDockOpen} onOpenChange={setIsAgentDockOpen} />
    </div>
  );
}
