import { Link, useLocation } from "react-router";
import { Mic, History, Settings, Clapperboard, Bell, Factory, Bot } from "lucide-react";
import type { LucideIcon } from "lucide-react";

interface NavRailProps {
  isAgentDockOpen?: boolean;
  onToggleAgentDock?: () => void;
}

interface NavRailLinkItem {
  path: string;
  label: string;
  icon: LucideIcon;
  exact?: boolean;
}

const primaryNavItems: NavRailLinkItem[] = [
  { path: "/generate/director", label: "导演", icon: Clapperboard },
];

const taskNavItems: NavRailLinkItem[] = [
  { path: "/tasks", label: "任务", icon: Factory },
];

const libraryNavItems: NavRailLinkItem[] = [
  { path: "/voices", label: "音色", icon: Mic },
  { path: "/history", label: "历史", icon: History },
];

const settingsNavItems: NavRailLinkItem[] = [
  { path: "/settings", label: "设置", icon: Settings },
];

export function NavRail({ isAgentDockOpen = false, onToggleAgentDock }: NavRailProps) {
  const location = useLocation();

  const renderNavLink = (item: NavRailLinkItem) => {
    const isActive = item.exact
      ? location.pathname === item.path
      : location.pathname.startsWith(item.path);

    const Icon = item.icon;
    return (
      <Link
        key={item.path}
        to={item.path}
        aria-current={isActive ? "page" : undefined}
        className={`
          flex flex-col items-center justify-center h-14 rounded-md transition-colors duration-fast relative
          focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60
          ${isActive
            ? "bg-accent-subtle text-accent"
            : "text-text-secondary hover:bg-bg-hover hover:text-text-primary"
          }
        `}
      >
        <Icon size={20} />
        <span className="text-[10px] font-medium mt-1">{item.label}</span>
      </Link>
    );
  };

  const renderDivider = (key: string) => <div key={key} className="w-10 h-px bg-border-subtle my-1 mx-auto" aria-hidden="true" />;

  return (
    <nav className="w-full h-full flex flex-col items-center py-3">
      {/* Logo */}
      <div className="w-8 h-8 rounded-md bg-accent flex items-center justify-center text-bg-base font-display font-bold text-lg mb-2 cursor-pointer">
        G
      </div>
      
      <div className="w-10 h-px bg-border-subtle my-2" />

      <div className="flex flex-col gap-2 w-full px-2 flex-1">
        {primaryNavItems.map(renderNavLink)}
        {renderDivider("task-divider")}
        {taskNavItems.map(renderNavLink)}
        {renderDivider("library-divider")}
        {libraryNavItems.map(renderNavLink)}
        {renderDivider("agent-divider")}
        <button
          type="button"
          aria-label={isAgentDockOpen ? "收起 Agent Dock，保持当前页面" : "展开 Agent Dock，保持当前页面"}
          aria-controls="global-agent-dock"
          aria-keyshortcuts="Control+Shift+A"
          aria-pressed={isAgentDockOpen}
          aria-expanded={isAgentDockOpen}
          data-state={isAgentDockOpen ? "open" : "closed"}
          title={isAgentDockOpen ? "收起 Agent Dock" : "展开 Agent Dock"}
          onClick={onToggleAgentDock}
          className={`
            flex flex-col items-center justify-center h-14 rounded-md transition-colors duration-fast relative
            focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60
            ${isAgentDockOpen
              ? "bg-accent-subtle text-accent shadow-[inset_0_0_0_1px_rgba(201,148,74,0.24)]"
              : "text-text-secondary hover:bg-bg-hover hover:text-text-primary"
            }
          `}
        >
          <span className={`absolute left-1 top-2 bottom-2 w-0.5 rounded-full transition-opacity ${isAgentDockOpen ? "opacity-100 bg-accent" : "opacity-0"}`} aria-hidden="true" />
          <Bot size={20} />
          <span className="text-[10px] font-medium mt-1">Agent</span>
          <span className={`absolute top-2 right-2 w-1.5 h-1.5 rounded-full transition-colors ${isAgentDockOpen ? "bg-accent" : "bg-text-tertiary/50"}`} aria-hidden="true" />
        </button>
      </div>

      <div className="w-full px-2 pb-2 mt-auto">
        {settingsNavItems.map(renderNavLink)}
        <button type="button" aria-label="查看通知" className="w-full h-14 rounded-md text-text-secondary hover:bg-bg-hover hover:text-text-primary flex flex-col items-center justify-center transition-colors duration-fast relative focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 mt-2">
          <Bell size={20} />
          <span className="text-[10px] font-medium mt-1">通知</span>
          <span className="absolute top-2 right-2 w-2 h-2 rounded-full bg-error" />
        </button>
      </div>
    </nav>
  );
}
