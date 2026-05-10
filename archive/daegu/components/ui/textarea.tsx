import * as React from "react";
import { cn } from "@/lib/utils";

export type TextareaProps = React.TextareaHTMLAttributes<HTMLTextAreaElement>;

const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, ...props }, ref) => {
    return (
      <textarea
        ref={ref}
        className={cn(
          "flex min-h-[100px] w-full border border-[var(--border)] bg-[var(--surface-raised)] px-3 py-2 text-[11px] font-mono text-[var(--text)] placeholder:text-[var(--text-dim)] focus-visible:outline-none focus-visible:border-[var(--accent)] focus-visible:ring-0 disabled:cursor-not-allowed disabled:opacity-50 resize-none transition-colors",
          className
        )}
        {...props}
      />
    );
  }
);
Textarea.displayName = "Textarea";
export { Textarea };
