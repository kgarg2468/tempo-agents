import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center px-2 py-0.5 text-[8px] font-mono font-semibold tracking-[0.22em] uppercase border transition-colors",
  {
    variants: {
      variant: {
        default: "border-[var(--border-raised)] bg-[var(--surface-raised)] text-[var(--text-muted)]",
        active: "border-[var(--accent)] bg-[var(--accent-dim)]/60 text-[var(--accent-bright)]",
        pending: "border-[var(--amber)] bg-[var(--amber-dim)]/50 text-[var(--amber)]",
        fired: "border-[var(--text-dim)] bg-[var(--surface-raised)] text-[var(--text-dim)]",
        spared: "border-[var(--blue)] bg-[var(--blue-dim)]/50 text-[var(--blue-text)]",
      },
    },
    defaultVariants: { variant: "default" },
  }
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
