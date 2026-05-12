"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Bot,
  GitBranch,
  ListChecks,
  LockKeyhole,
  Settings,
  ShieldAlert,
  Waypoints
} from "lucide-react";
import { EventStreamRefresh } from "./event-stream-refresh";

const navItems = [
  { href: "/sessions", label: "Sessions", icon: Waypoints },
  { href: "/agents", label: "Agents", icon: Bot },
  { href: "/conflicts", label: "Conflicts", icon: ShieldAlert },
  { href: "/interventions", label: "Interventions", icon: GitBranch },
  { href: "/privacy", label: "Privacy", icon: LockKeyhole },
  { href: "/evals", label: "Evals", icon: ListChecks },
  { href: "/settings", label: "Settings", icon: Settings }
];

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  return (
    <div className="app-shell">
      <EventStreamRefresh />
      <aside className="sidebar">
        <div className="brand">Tempo</div>
        <nav className="nav">
          {navItems.map((item) => {
            const Icon = item.icon;
            const active = pathname === item.href;
            return (
              <Link
                className={`nav-link ${active ? "active" : ""}`}
                href={item.href}
                key={item.href}
              >
                <Icon size={16} />
                {item.label}
              </Link>
            );
          })}
        </nav>
      </aside>
      <main className="main">{children}</main>
    </div>
  );
}
