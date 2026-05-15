import { Link } from "react-router";
import { ArrowLeft, Terminal } from "lucide-react";
import { OpenCodeSettingsPanel } from "./OpenCodeSettingsPanel";

export function OpenCodeSettingsPage() {
  return (
    <div className="flex h-full flex-col overflow-y-auto bg-bg-base">
      <div className="mx-auto flex w-full max-w-[1480px] flex-col gap-6 p-8">
        <div className="flex items-start justify-between gap-4">
          <div className="flex flex-col gap-3">
            <Link
              to="/settings"
              className="inline-flex w-fit items-center gap-2 rounded-md border border-border bg-bg-surface px-3 py-1.5 text-xs font-medium text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
            >
              <ArrowLeft size={14} /> 返回设置
            </Link>
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg border border-accent/20 bg-accent-muted text-accent">
                <Terminal size={20} />
              </div>
              <div>
                <h2 className="font-display text-2xl font-bold text-text-primary">OpenCode 管理</h2>
                <p className="mt-1 text-sm leading-6 text-text-tertiary">集中查看 CLI 状态、配置路径、Provider 可视化配置和受控安装能力。</p>
              </div>
            </div>
          </div>
        </div>

        <OpenCodeSettingsPanel />
      </div>
    </div>
  );
}
