import * as React from "react";
import { cn } from "@/lib/utils";

export type InputProps = React.InputHTMLAttributes<HTMLInputElement>;

const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, ...props }, ref) => (
    <input
      type={type}
      ref={ref}
      className={cn(
        "flex h-9 w-full border border-[var(--border)] bg-[var(--surface-raised)] px-3 py-2 text-xs font-mono text-[var(--text)] placeholder:text-[var(--text-dim)] focus-visible:outline-none focus-visible:border-[var(--accent)] focus-visible:ring-0 disabled:cursor-not-allowed disabled:opacity-50 transition-colors",
        className
      )}
      {...props}
    />
  )
);
Input.displayName = "Input";
export { Input };
