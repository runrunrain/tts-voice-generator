import { useId, useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

interface SettingsSectionProps {
  title: string;
  description?: string;
  icon?: ReactNode;
  open?: boolean;
  defaultOpen?: boolean;
  children: ReactNode;
  actions?: ReactNode;
  className?: string;
  contentClassName?: string;
  onOpenChange?: (open: boolean) => void;
}

export function SettingsSection({
  title,
  description,
  icon,
  open: controlledOpen,
  defaultOpen = true,
  children,
  actions,
  className = "",
  contentClassName = "",
  onOpenChange,
}: SettingsSectionProps) {
  const contentId = useId();
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen);
  const isControlled = controlledOpen !== undefined;
  const open = controlledOpen ?? uncontrolledOpen;

  const toggle = () => {
    const nextOpen = !open;
    if (!isControlled) {
      setUncontrolledOpen(nextOpen);
    }
    onOpenChange?.(nextOpen);
  };

  return (
    <section className={`flex flex-col gap-3 ${className}`}>
      <div className="flex items-start justify-between gap-3">
        <button
          type="button"
          className="group min-w-0 flex flex-1 items-start gap-2 rounded-md text-left text-sm font-semibold text-text-primary transition-colors hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 focus-visible:ring-offset-2 focus-visible:ring-offset-bg-base"
          onClick={toggle}
          aria-expanded={open}
          aria-controls={contentId}
        >
          <span className="mt-0.5 shrink-0 text-text-tertiary transition-colors group-hover:text-accent">
            {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
          </span>
          {icon && <span className="mt-0.5 shrink-0 text-accent">{icon}</span>}
          <span className="min-w-0 flex flex-col gap-1">
            <span>{title}</span>
            {description && <span className="text-xs font-normal leading-5 text-text-tertiary">{description}</span>}
          </span>
        </button>
        {actions && <div className="shrink-0">{actions}</div>}
      </div>

      {open && (
        <div id={contentId} className={contentClassName}>
          {children}
        </div>
      )}
    </section>
  );
}
