import type { ReactNode } from "react";

interface PromptTextBlockProps {
  children: ReactNode;
  minHeightClass?: string;
  maxHeightClass?: string;
  className?: string;
}

export function PromptTextBlock({
  children,
  minHeightClass = "min-h-[160px]",
  maxHeightClass = "max-h-[40vh]",
  className = "",
}: PromptTextBlockProps) {
  return (
    <div
      className={`bg-bg-sunken p-4 rounded-md border border-border font-mono text-xs text-text-secondary min-w-0 max-w-full ${minHeightClass} ${maxHeightClass} overflow-y-auto overflow-x-auto whitespace-pre-wrap break-words [overflow-wrap:anywhere] [word-break:normal] leading-relaxed text-left ${className}`}
      style={{ writingMode: "horizontal-tb", unicodeBidi: "plaintext" }}
    >
      {children}
    </div>
  );
}
