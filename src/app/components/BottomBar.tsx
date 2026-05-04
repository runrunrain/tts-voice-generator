import { useState, useEffect } from "react";
import { useAppState } from "../state/AppContext";

interface HealthInfo {
  ok: boolean;
  openRouterConfigured: boolean;
  version: string;
  uptime: number;
}

export function BottomBar() {
  const { historyRecords } = useAppState();
  const [health, setHealth] = useState<HealthInfo | null>(null);

  useEffect(() => {
    const fetchHealth = () => {
      fetch("/api/health")
        .then((res) => res.json())
        .then((data) => {
          setHealth({
            ok: data.status === "ok",
            openRouterConfigured: !!data.openRouterConfigured,
            version: data.version || "0.1.0",
            uptime: data.uptime || 0,
          });
        })
        .catch(() => {
          setHealth(null);
        });
    };
    fetchHealth();
    const interval = setInterval(fetchHealth, 30000);
    return () => clearInterval(interval);
  }, []);

  const statusDot = !health
    ? "bg-error"
    : health.ok && health.openRouterConfigured
      ? "bg-success"
      : "bg-warning";
  const statusText = !health
    ? "后端不可达"
    : health.ok && health.openRouterConfigured
      ? "后端已连接 / OpenRouter Key 已配置"
      : "后端已连接 / OpenRouter Key 未配置";

  return (
    <div className="h-full px-4 flex items-center justify-between text-[11px] text-text-tertiary">
      <div className="flex items-center gap-4">
        <span className="hover:text-text-secondary cursor-pointer transition-colors">
          127.0.0.1:5173
        </span>
        <span className="flex items-center gap-1.5">
          <div className={`w-1.5 h-1.5 rounded-full ${statusDot}`} />
          {statusText}
        </span>
      </div>

      <div className="flex items-center gap-4">
        <span>历史记录: {historyRecords.length}</span>
        <span>v{health?.version ?? "---"}</span>
      </div>
    </div>
  );
}
