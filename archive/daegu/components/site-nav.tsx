"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

const links = [
  { href: "/", label: "Active Roster" },
  { href: "/office", label: "Office" },
  { href: "/pyre", label: "The Pyre" },
  { href: "/digital-employees", label: "Digital Employees" },
  { href: "/channels", label: "Channels" },
  { href: "/criteria", label: "Criteria" },
];

export function SiteNav() {
  const pathname = usePathname();
  return (
    <header className="sticky top-0 z-30 bg-[var(--bg)]/95 backdrop-blur-md border-b border-[var(--border)]">
      <div className="h-[2px] bg-gradient-to-r from-[var(--accent-dim)] via-[var(--accent)] to-[var(--accent-dim)]" />
      <div className="mx-auto max-w-6xl px-6 flex items-stretch">
        <Link href="/" className="group flex items-baseline gap-3 py-3 pr-6 border-r border-[var(--border)] mr-2">
          <span className="font-display text-lg font-semibold text-[var(--text)] group-hover:text-[var(--accent-bright)] transition-colors leading-none">
            OpenFire
          </span>
          <span className="text-[8px] font-mono tracking-[0.3em] text-[var(--text-dim)] uppercase">
            Protocol
          </span>
        </Link>

        <nav className="flex items-stretch">
          {links.map((l) => {
            const active = l.href === "/" ? pathname === "/" : pathname.startsWith(l.href);
            return (
              <Link
                key={l.href}
                href={l.href}
                className={cn(
                  "relative flex items-center px-4 text-[11px] font-mono tracking-[0.14em] uppercase transition-colors border-r border-[var(--border)]",
                  active
                    ? "text-[var(--text)] bg-[var(--surface-raised)]"
                    : "text-[var(--text-muted)] hover:text-[var(--text)] hover:bg-[var(--surface)]"
                )}
              >
                {active && (
                  <span className="absolute bottom-0 left-0 right-0 h-[2px] bg-[var(--accent)]" />
                )}
                {l.label}
              </Link>
            );
          })}
        </nav>

        <div className="ml-auto flex items-center">
          <div className="text-[8px] font-mono tracking-[0.2em] text-[var(--text-dim)] uppercase">
            The Claw · Active
          </div>
        </div>
      </div>
    </header>
  );
}
