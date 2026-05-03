import { Outlet, useLocation } from "react-router";
import { NavRail } from "./NavRail";
import { TopBar } from "./TopBar";
import { BottomBar } from "./BottomBar";
import { RightPanel } from "./RightPanel";
import { useState } from "react";

export function Shell() {
  const [isRightPanelOpen, setIsRightPanelOpen] = useState(true);
  const location = useLocation();

  // Certain routes hide the right panel completely
  const hideRightPanelRoutes = ["/history/:jobId", "/settings"];
  const isRightPanelHidden = hideRightPanelRoutes.some(route => {
    if (route.includes(":jobId")) {
      return location.pathname.startsWith("/history/") && location.pathname.split("/").length > 2;
    }
    return location.pathname === route;
  });

  return (
    <div 
      className="h-screen w-screen overflow-hidden bg-bg-base text-text-primary"
      style={{
        display: "grid",
        gridTemplateColumns: `72px 1fr ${isRightPanelHidden ? '0px' : isRightPanelOpen ? '384px' : '0px'}`,
        gridTemplateRows: "48px 1fr 28px",
      }}
    >
      <div className="row-span-3 col-start-1 col-end-2 border-r border-border-subtle bg-bg-base">
        <NavRail />
      </div>

      <div className="col-start-2 col-end-4 row-start-1 row-end-2 border-b border-border-subtle bg-bg-base">
        <TopBar />
      </div>

      <div className="col-start-2 col-end-3 row-start-2 row-end-3 overflow-y-auto bg-bg-base relative">
        <Outlet />
      </div>

      {!isRightPanelHidden && (
        <div 
          className="col-start-3 col-end-4 row-start-2 row-end-3 bg-bg-elevated border-l border-border-subtle flex flex-col relative"
          style={{ width: isRightPanelOpen ? 384 : 0, transition: "width 400ms cubic-bezier(0.4, 0, 0.2, 1)" }}
        >
          {/* Splitter */}
          <div 
            className="absolute left-0 top-0 bottom-0 w-[4px] cursor-col-resize hover:bg-accent/50 active:bg-accent -translate-x-1/2 z-50 transition-colors"
            onDoubleClick={() => setIsRightPanelOpen(!isRightPanelOpen)}
          />
          <div className="flex-1 overflow-y-auto overflow-x-hidden min-w-[280px]">
            <RightPanel isOpen={isRightPanelOpen} onClose={() => setIsRightPanelOpen(false)} />
          </div>
        </div>
      )}

      <div className="col-start-2 col-end-4 row-start-3 row-end-4 bg-bg-sunken border-t border-border-subtle">
        <BottomBar />
      </div>
    </div>
  );
}
