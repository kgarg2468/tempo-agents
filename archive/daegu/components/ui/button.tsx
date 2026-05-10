"use client";

import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap text-[10px] font-mono font-semibold tracking-[0.16em] uppercase focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--ring)] disabled:pointer-events-none disabled:opacity-40 active:scale-[0.97]",
  {
    variants: {
      variant: {
        default:
          "bg-[var(--accent)] text-[var(--text)] hover:bg-[var(--accent-bright)] border border-[var(--accent-bright)]/60 shadow-[0_0_18px_-4px_var(--accent-glow)] transition-[background-color,box-shadow,transform] duration-150",
        fire:
          "bg-[var(--accent)] text-[var(--text)] hover:bg-[var(--accent-bright)] border border-[var(--accent)] shadow-[0_0_14px_-3px_var(--accent-glow)] hover:shadow-[0_0_22px_-2px_var(--accent-glow)] transition-[background-color,box-shadow,transform] duration-150",
        secondary:
          "bg-[var(--surface-raised)] text-[var(--text)] hover:bg-[var(--surface-hover)] border border-[var(--border)] transition-[background-color,transform] duration-150",
        ghost:
          "hover:bg-[var(--surface-raised)] text-[var(--text-muted)] hover:text-[var(--text)] border border-transparent transition-[background-color,color,transform] duration-150",
        outline:
          "border border-[var(--border)] bg-transparent text-[var(--text-muted)] hover:bg-[var(--surface-raised)] hover:text-[var(--text)] transition-[background-color,color,transform] duration-150",
        destructive:
          "bg-[var(--accent)] text-[var(--text)] hover:bg-[var(--accent-bright)] border border-[var(--accent)] transition-[background-color,transform] duration-150",
        success:
          "bg-[var(--green)] text-[var(--text)] hover:bg-[#2d7d55] border border-[var(--green)] transition-[background-color,transform] duration-150",
      },
      size: {
        default: "h-9 px-4 py-2",
        sm: "h-7 px-3",
        lg: "h-11 px-6 text-xs",
        icon: "h-8 w-8",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, ...props }, ref) => (
    <button
      ref={ref}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
);
Button.displayName = "Button";

export { Button, buttonVariants };
