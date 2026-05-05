import { Bot, ChevronDown, ChevronUp, Loader2, MessageSquare, Send, ShieldAlert } from "lucide-react";
import { useGlobalAgentDock } from "../hooks/useGlobalAgentDock";

export function GlobalAgentDock() {
  const { isOpen, toggle, context, session, messages, draft, setDraft, sending, error, send } = useGlobalAgentDock();

  return (
    <div className={`fixed right-4 bottom-10 z-[80] transition-all duration-300 ${isOpen ? "w-[420px]" : "w-[220px]"}`}>
      <div className="rounded-lg border border-border-subtle bg-bg-elevated shadow-shadow-lg overflow-hidden">
        <button className="w-full h-11 px-3 flex items-center justify-between bg-bg-sunken border-b border-border-subtle hover:bg-bg-hover transition-colors" onClick={toggle} aria-expanded={isOpen}>
          <span className="flex items-center gap-2 text-sm font-semibold"><Bot size={16} className="text-accent" /> Global Agent Dock</span>
          {isOpen ? <ChevronDown size={15} className="text-text-tertiary" /> : <ChevronUp size={15} className="text-text-tertiary" />}
        </button>

        {isOpen && (
          <div className="h-[540px] flex flex-col">
            <div className="px-3 py-2 border-b border-border-subtle bg-bg-base">
              <div className="text-[10px] uppercase tracking-[0.22em] text-text-tertiary">Context Strip</div>
              <div className="mt-1 flex items-center gap-2 text-xs">
                <span className="px-2 py-0.5 rounded bg-accent-muted text-accent border border-accent/20">{context.pageLabel}</span>
                <span className="text-text-tertiary truncate">{context.pagePath}</span>
              </div>
              <div className="mt-1 text-[10px] text-text-tertiary font-mono">task: {context.taskId ?? "none"} · chat session: {session?.id ?? "not created"}</div>
            </div>

            {error && (
              <div className="mx-3 mt-3 px-3 py-2 rounded border border-warning/20 bg-warning-muted text-warning text-xs flex items-start gap-2">
                <ShieldAlert size={14} className="shrink-0 mt-0.5" />
                <span>Agent Chat 不可用：{error}</span>
              </div>
            )}

            <div className="flex-1 overflow-y-auto p-3 flex flex-col gap-3">
              {messages.length === 0 ? (
                <div className="h-full flex flex-col items-center justify-center text-center text-text-tertiary gap-2 px-8">
                  <MessageSquare size={22} />
                  <div className="text-sm font-medium">Dock Chat 独立会话</div>
                  <div className="text-xs leading-5">这里不会复用任务自动化 session。发送消息后才创建真实后端 chat session。</div>
                </div>
              ) : messages.map((message) => (
                <div key={message.id} className={`max-w-[86%] rounded-md border px-3 py-2 text-xs leading-5 ${message.role === "user" ? "self-end bg-accent-muted border-accent/20 text-text-primary" : "self-start bg-bg-sunken border-border text-text-secondary"}`}>
                  <div className="text-[10px] text-text-tertiary mb-1">{message.role} · {new Date(message.createdAt).toLocaleTimeString("zh-CN")}</div>
                  <div className="whitespace-pre-wrap break-words">{message.content}</div>
                  {message.status === "failed" && <div className="text-error text-[10px] mt-1">{message.error ?? "发送失败"}</div>}
                </div>
              ))}
            </div>

            <form className="p-3 border-t border-border-subtle bg-bg-sunken flex gap-2" onSubmit={(event) => { event.preventDefault(); send(); }}>
              <textarea className="flex-1 h-20 bg-bg-base border border-border rounded-md p-2 text-xs resize-none outline-none focus:border-border-focus" value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="向 OpenCode-Agent 提问，非流式发送" disabled={sending} />
              <button className="w-12 rounded-md bg-accent text-bg-base flex items-center justify-center disabled:opacity-50" disabled={!draft.trim() || sending} title="发送消息">
                {sending ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
              </button>
            </form>
          </div>
        )}
      </div>
    </div>
  );
}
