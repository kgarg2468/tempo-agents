import type { Metadata } from "next";
import "./styles.css";

export const metadata: Metadata = {
  title: "Rebase",
  description: "Local-first coordination for parallel AI coding sessions"
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

