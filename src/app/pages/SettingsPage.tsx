import { Eye, RefreshCw } from "lucide-react";

export function SettingsPage() {
  return (
    <div className="flex flex-col h-full bg-bg-base overflow-y-auto">
      <div className="max-w-[1848px] w-full mx-auto p-8 flex flex-col gap-8">
        
        <div className="h-12 shrink-0">
          <h2 className="text-2xl font-bold font-display text-text-primary">设置</h2>
        </div>

        <div className="flex gap-8 items-start">
          
          {/* Left Column */}
          <div className="flex-1 max-w-[640px] flex flex-col gap-6">
            
            <div className="flex flex-col gap-3">
              <h3 className="text-sm font-semibold text-text-primary">API Key 配置</h3>
              <div className="bg-bg-surface border border-border rounded-lg p-5 flex flex-col gap-4">
                <div className="flex flex-col gap-1.5">
                  <label className="text-sm text-text-secondary">OpenRouter API Key</label>
                  <div className="flex items-center gap-2">
                    <div className="relative flex-1">
                      <input 
                        type="password" 
                        defaultValue="sk-or-v1-abc123def456" 
                        className="w-full bg-bg-sunken border border-border rounded-md px-3 py-2 text-sm outline-none focus:border-border-focus font-mono text-text-primary"
                      />
                      <button className="absolute right-3 top-1/2 -translate-y-1/2 text-text-tertiary hover:text-text-primary">
                        <Eye size={16} />
                      </button>
                    </div>
                    <button className="px-4 py-2 bg-bg-base border border-border rounded-md text-sm font-medium hover:bg-bg-hover transition-colors">
                      测试
                    </button>
                  </div>
                </div>
                <div className="flex items-center gap-2 text-sm">
                  <span className="text-text-tertiary">状态:</span>
                  <span className="px-2 py-0.5 rounded text-[11px] font-medium bg-success-muted text-success border border-success/20">
                    已配置
                  </span>
                </div>
              </div>
            </div>

            <div className="flex flex-col gap-3">
              <h3 className="text-sm font-semibold text-text-primary">默认参数</h3>
              <div className="bg-bg-surface border border-border rounded-lg p-5 flex flex-col gap-4">
                <div className="flex items-center justify-between">
                  <label className="text-sm text-text-secondary w-32">默认模型:</label>
                  <select className="flex-1 bg-bg-sunken border border-border rounded-md px-3 py-2 text-sm outline-none focus:border-border-focus">
                    <option>gemini-3.1-flash</option>
                  </select>
                </div>
                <div className="flex items-center justify-between">
                  <label className="text-sm text-text-secondary w-32">默认音色:</label>
                  <select className="flex-1 bg-bg-sunken border border-border rounded-md px-3 py-2 text-sm outline-none focus:border-border-focus">
                    <option>alloy</option>
                  </select>
                </div>
                <div className="flex items-center justify-between">
                  <label className="text-sm text-text-secondary w-32">默认格式:</label>
                  <div className="flex-1 flex gap-4">
                    <label className="flex items-center gap-2 text-sm cursor-pointer">
                      <input type="radio" name="format" defaultChecked className="accent-accent" /> mp3
                    </label>
                    <label className="flex items-center gap-2 text-sm cursor-pointer">
                      <input type="radio" name="format" className="accent-accent" /> pcm
                    </label>
                  </div>
                </div>
                <div className="flex items-center justify-between">
                  <label className="text-sm text-text-secondary w-32">音频目录:</label>
                  <input 
                    type="text" 
                    defaultValue="./data/audio" 
                    className="flex-1 bg-bg-sunken border border-border rounded-md px-3 py-2 text-sm outline-none focus:border-border-focus font-mono"
                  />
                </div>
              </div>
            </div>

          </div>

          {/* Right Column */}
          <div className="flex-1 flex flex-col gap-6">
            
            <div className="flex flex-col gap-3">
              <h3 className="text-sm font-semibold text-text-primary">请求限制</h3>
              <div className="bg-bg-surface border border-border rounded-lg p-5 flex flex-col gap-4">
                <div className="flex flex-col gap-1.5">
                  <label className="text-sm text-text-secondary">单次最大字符数</label>
                  <input 
                    type="number" 
                    defaultValue={5000} 
                    className="w-full bg-bg-sunken border border-border rounded-md px-3 py-2 text-sm outline-none focus:border-border-focus font-mono"
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <label className="text-sm text-text-secondary">最大并发请求数</label>
                  <input 
                    type="number" 
                    defaultValue={2} 
                    className="w-full bg-bg-sunken border border-border rounded-md px-3 py-2 text-sm outline-none focus:border-border-focus font-mono"
                  />
                </div>
              </div>
            </div>

            <div className="flex flex-col gap-3">
              <h3 className="text-sm font-semibold text-text-primary">插件 Token</h3>
              <div className="bg-bg-surface border border-border rounded-lg p-5 flex flex-col gap-4">
                <div className="flex flex-col gap-1.5">
                  <label className="text-sm text-text-secondary">本地 Token</label>
                  <div className="flex items-center gap-2">
                    <input 
                      type="password" 
                      defaultValue="token-xxxxxxxx" 
                      readOnly
                      className="flex-1 bg-bg-sunken border border-border rounded-md px-3 py-2 text-sm outline-none font-mono text-text-tertiary"
                    />
                    <button className="px-3 py-2 bg-bg-base border border-border rounded-md text-sm font-medium hover:bg-bg-hover transition-colors flex items-center gap-2">
                      <RefreshCw size={14} /> 生成新
                    </button>
                  </div>
                </div>
                <div className="flex items-center gap-2 text-sm">
                  <span className="text-text-tertiary">状态:</span>
                  <span className="px-2 py-0.5 rounded text-[11px] font-medium bg-success-muted text-success border border-success/20">
                    已启用
                  </span>
                </div>
              </div>
            </div>

          </div>
        </div>

        {/* Agent Auth (Full Width) */}
        <div className="flex flex-col gap-3">
          <h3 className="text-sm font-semibold text-text-primary">Agent 授权</h3>
          <div className="bg-bg-surface border border-border rounded-lg p-5 flex flex-col gap-6">
            
            <div className="flex items-center gap-6">
              <label className="text-sm text-text-secondary w-20">授权模式:</label>
              <div className="flex gap-6">
                <label className="flex items-center gap-2 text-sm cursor-pointer">
                  <input type="radio" name="auth" className="accent-accent" /> 每次确认
                </label>
                <label className="flex items-center gap-2 text-sm cursor-pointer">
                  <input type="radio" name="auth" defaultChecked className="accent-accent" /> 会话自动批准
                </label>
              </div>
            </div>

            <div className="border border-border-subtle rounded-md bg-bg-sunken p-4 flex flex-col gap-4">
              <h4 className="text-xs font-semibold text-text-secondary uppercase tracking-wider">会话限制 (Session Limits)</h4>
              
              <div className="grid grid-cols-4 gap-4">
                <div className="flex flex-col gap-1.5">
                  <label className="text-xs text-text-tertiary">最大请求数</label>
                  <input type="number" defaultValue={10} className="w-full bg-bg-base border border-border rounded px-2 py-1 text-sm outline-none focus:border-border-focus font-mono" />
                </div>
                <div className="flex flex-col gap-1.5">
                  <label className="text-xs text-text-tertiary">最大字符数</label>
                  <input type="number" defaultValue={10000} className="w-full bg-bg-base border border-border rounded px-2 py-1 text-sm outline-none focus:border-border-focus font-mono" />
                </div>
                <div className="flex flex-col gap-1.5">
                  <label className="text-xs text-text-tertiary">最大费用</label>
                  <div className="relative">
                    <span className="absolute left-2 top-1/2 -translate-y-1/2 text-text-tertiary text-sm">$</span>
                    <input type="number" step="0.01" defaultValue={0.01} className="w-full bg-bg-base border border-border rounded px-2 py-1 pl-5 text-sm outline-none focus:border-border-focus font-mono" />
                  </div>
                </div>
                <div className="flex flex-col gap-1.5">
                  <label className="text-xs text-text-tertiary">过期时间 (秒)</label>
                  <input type="number" defaultValue={3600} className="w-full bg-bg-base border border-border rounded px-2 py-1 text-sm outline-none focus:border-border-focus font-mono" />
                </div>
              </div>

              <div className="h-px bg-border-subtle my-2" />
              
              <div className="flex items-center justify-between text-sm">
                <div className="flex items-center gap-2">
                  <span className="text-text-tertiary">当前会话状态:</span>
                  <span className="px-2 py-0.5 rounded text-[11px] font-medium bg-accent-muted text-accent border border-accent/20">
                    已激活
                  </span>
                </div>
                
                <div className="flex items-center gap-4">
                  <div className="flex items-center gap-2 text-xs">
                    <span className="text-text-tertiary">已用额度:</span>
                    <div className="w-24 h-1.5 bg-border-subtle rounded-full overflow-hidden">
                      <div className="h-full bg-accent w-[30%]" />
                    </div>
                    <span className="font-mono">3/10</span>
                  </div>
                  <button className="text-xs text-error hover:text-error/80 transition-colors">
                    撤销授权
                  </button>
                </div>
              </div>

            </div>

          </div>
        </div>
      </div>

      <div className="h-[52px] shrink-0 bg-bg-sunken border-t border-border-subtle mt-auto flex items-center justify-end px-8 sticky bottom-0 z-10">
        <button className="px-6 py-2 rounded-md bg-accent text-bg-base text-sm font-medium hover:bg-accent-hover active:bg-accent-active transition-colors shadow-shadow-glow">
          保存设置
        </button>
      </div>
    </div>
  );
}
