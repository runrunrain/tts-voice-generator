import { useEffect, useRef } from "react";
import { Bot, ChevronDown, ChevronUp, Loader2, MessageSquare, Send, ShieldAlert } from "lucide-react";
import { useGlobalAgentDock } from "../hooks/useGlobalAgentDock";

interface GlobalAgentDockProps {
  isOpen?: boolean;
  onOpenChange?: (isOpen: boolean) => void;
}

export function GlobalAgentDock({ isOpen: controlledIsOpen, onOpenChange }: GlobalAgentDockProps) {
  const { isOpen, toggle, context, session, messages, draft, setDraft, sending, error, send } = useGlobalAgentDock({
    isOpen: controlledIsOpen,
    onOpenChange,
  });
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const contentId = "global-agent-dock-content";

  useEffect(() => {
    if (!isOpen) return;
    const frame = window.requestAnimationFrame(() => composerRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [isOpen]);

  return (
    <div id="global-agent-dock" className={`fixed right-0 top-[60px] bottom-[40px] z-[80] flex items-stretch transition-[width] duration-300 ${isOpen ? "w-[min(480px,calc(100vw-96px))]" : "w-9"}`}>
      <section className={`h-full w-full border border-border-subtle bg-bg-elevated shadow-shadow-lg overflow-hidden ${isOpen ? "rounded-l-lg" : "rounded-l-md"}`} aria-label="Global Agent Dock" data-state={isOpen ? "open" : "closed"}>
        <button
          type="button"
          className={`${isOpen ? "w-full h-11 px-3 flex-row justify-between border-b" : "h-full w-full flex-col justify-center gap-3 py-3"} flex items-center bg-bg-sunken border-border-subtle hover:bg-bg-hover transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60`}
          onClick={toggle}
          aria-controls={contentId}
          aria-expanded={isOpen}
          aria-label={isOpen ? "收起 Global Agent Dock" : "展开 Global Agent Dock"}
        >
          <span className={`${isOpen ? "flex-row text-sm" : "flex-col text-[10px]"} flex items-center gap-2 font-semibold`}><Bot size={16} className="text-accent" /> <span className={isOpen ? "" : "[writing-mode:vertical-rl] tracking-[0.18em]"}>Agent</span>{isOpen && " Global Dock"}</span>
          {isOpen ? <ChevronDown size={15} className="text-text-tertiary" /> : <ChevronUp size={15} className="text-text-tertiary" />}
        </button>

        {isOpen && (
          <div id={contentId} className="h-[calc(100%-44px)] flex flex-col" role="complementary" aria-label="Global Agent Dock 聊天面板" aria-busy={sending}>
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
              <textarea ref={composerRef} className="flex-1 h-20 bg-bg-base border border-border rounded-md p-2 text-xs resize-none outline-none focus:border-border-focus" value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="向 OpenCode-Agent 提问，非流式发送" disabled={sending} aria-label="Agent Chat 输入框" />
              <button type="submit" className="w-12 rounded-md bg-accent text-bg-base flex items-center justify-center disabled:opacity-50" disabled={!draft.trim() || sending} title="发送消息" aria-label="发送 Agent Chat 消息">
                {sending ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
              </button>
            </form>
          </div>
        )}
      </section>
    </div>
  );
}
