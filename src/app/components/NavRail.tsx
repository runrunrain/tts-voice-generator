import { Link, useLocation } from "react-router";
import { Mic, History, Settings, Play, Clapperboard, Bell } from "lucide-react";

export function NavRail() {
  const location = useLocation();

  const navItems = [
    { path: "/generate", label: "生成", icon: Play, exact: true },
    { path: "/generate/director", label: "导演", icon: Clapperboard },
    { path: "/voices", label: "音色", icon: Mic },
    { path: "/history", label: "历史", icon: History },
    { path: "/settings", label: "设置", icon: Settings },
  ];

  return (
    <nav className="w-full h-full flex flex-col items-center py-3">
      {/* Logo */}
      <div className="w-8 h-8 rounded-md bg-accent flex items-center justify-center text-bg-base font-display font-bold text-lg mb-2 cursor-pointer">
        G
      </div>
      
      <div className="w-10 h-px bg-border-subtle my-2" />

      <div className="flex flex-col gap-2 w-full px-2 flex-1">
        {navItems.map((item) => {
          const isActive = item.exact 
            ? location.pathname === item.path 
            : location.pathname.startsWith(item.path);

          const Icon = item.icon;
          return (
            <Link
              key={item.path}
              to={item.path}
              className={`
                flex flex-col items-center justify-center h-14 rounded-md transition-colors duration-fast
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
        })}
      </div>

      <div className="w-full px-2 pb-2 mt-auto">
        <button className="w-full h-14 rounded-md text-text-secondary hover:bg-bg-hover hover:text-text-primary flex flex-col items-center justify-center transition-colors duration-fast relative">
          <Bell size={20} />
          <span className="text-[10px] font-medium mt-1">通知</span>
          <span className="absolute top-2 right-2 w-2 h-2 rounded-full bg-error" />
        </button>
      </div>
    </nav>
  );
}
