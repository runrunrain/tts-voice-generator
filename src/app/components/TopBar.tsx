import { useState, useEffect } from "react";
import type { ReactNode } from "react";
import { useLocation } from "react-router";
import { ChevronRight } from "lucide-react";

interface HealthStatus {
  ok: boolean;
  openRouterConfigured: boolean;
  version: string;
}

export function TopBar({ agentPanelSlot }: { agentPanelSlot?: ReactNode }) {
  const location = useLocation();
  const [health, setHealth] = useState<HealthStatus | null>(null);

  useEffect(() => {
    fetch("/api/health")
      .then((res) => res.json())
      .then((data) => {
        setHealth({
          ok: data.status === "ok",
          openRouterConfigured: !!data.openRouterConfigured,
          version: data.version || "0.1.0",
        });
      })
      .catch(() => {
        setHealth(null);
      });
  }, []);

  let breadcrumbs = ["生成", "单次"];
  let title = "语音生成";

  if (location.pathname.includes("/director")) {
    breadcrumbs = ["生成", "导演模式"];
    title = "导演模式";
  } else if (location.pathname.includes("/voices")) {
    breadcrumbs = ["音色管理"];
    title = "音色管理";
  } else if (location.pathname.includes("/history")) {
    breadcrumbs = ["历史记录"];
    title = "历史记录";
    if (location.pathname.length > "/history".length) {
      breadcrumbs.push("详情");
      title = "记录详情";
    }
  } else if (location.pathname.includes("/settings")) {
    breadcrumbs = ["设置"];
    title = "系统设置";
  } else if (location.pathname.includes("/tasks")) {
    breadcrumbs = ["生产任务"];
    title = "语音制片工作台";
    if (location.pathname.length > "/tasks".length) {
      breadcrumbs.push("工作台");
      title = "任务工作台";
    }
  }

  const statusColor = !health
    ? "bg-error"
    : health.ok && health.openRouterConfigured
      ? "bg-success"
      : "bg-warning";
  const statusShadow = !health
    ? "shadow-[0_0_8px_rgba(239,68,68,0.4)]"
    : health.ok && health.openRouterConfigured
      ? "shadow-[0_0_8px_rgba(34,197,94,0.4)]"
      : "shadow-[0_0_8px_rgba(197,158,49,0.4)]";
  const statusText = !health
    ? "后端不可达"
    : health.ok && health.openRouterConfigured
      ? "后端正常 / 密钥已配置"
      : "后端正常 / 缺少密钥";

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

      <div className="flex-1 flex items-center justify-end gap-3 min-w-0">
        {agentPanelSlot}
        <div className="hidden min-[960px]:flex items-center gap-2 text-sm text-text-tertiary whitespace-nowrap">
          <div className={`w-2 h-2 rounded-full ${statusColor} ${statusShadow}`} />
          {statusText}
        </div>
      </div>
    </div>
  );
}
