import { useLocation } from "react-router";
import { ChevronRight } from "lucide-react";

export function TopBar() {
  const location = useLocation();

  // Very basic breadcrumb logic for demonstration
  let breadcrumbs = ["生成", "单次"];
  let title = "语音生成";

  if (location.pathname.includes("/director")) {
    breadcrumbs = ["生成", "Director 模式"];
    title = "Director 模式";
  } else if (location.pathname.includes("/voices")) {
    breadcrumbs = ["音色管理"];
    title = "音色管理";
  } else if (location.pathname.includes("/history")) {
    breadcrumbs = ["历史记录"];
    title = "历史记录";
    if (location.pathname.length > "/history".length) {
      breadcrumbs.push(`详情`);
      title = "记录详情";
    }
  } else if (location.pathname.includes("/settings")) {
    breadcrumbs = ["设置"];
    title = "系统设置";
  }

  return (
    <div className="h-full px-5 flex items-center justify-between">
      <div className="flex items-center gap-4 flex-1">
        <div className="flex items-center gap-1 text-sm text-text-secondary">
          {breadcrumbs.map((crumb, idx) => (
            <div key={idx} className="flex items-center gap-1">
              {idx > 0 && <ChevronRight size={14} className="text-text-tertiary" />}
              <span className={idx === breadcrumbs.length - 1 ? "text-text-primary" : ""}>
                {crumb}
              </span>
            </div>
          ))}
        </div>
      </div>

      <div className="flex-1 flex justify-center">
        <h2 className="text-lg font-semibold">{title}</h2>
      </div>

      <div className="flex-1 flex items-center justify-end gap-4">
        <div className="flex items-center gap-2 text-sm text-text-tertiary">
          <div className="w-2 h-2 rounded-full bg-warning shadow-[0_0_8px_rgba(197,158,49,0.4)]" />
          Demo API: simulated
        </div>
        <button className="px-3 py-1.5 text-sm font-medium rounded-md hover:bg-bg-hover transition-colors">
          快捷操作
        </button>
      </div>
    </div>
  );
}
