import type { Metadata } from "next";
import { Playfair_Display, IBM_Plex_Mono, Barlow_Condensed } from "next/font/google";
import "./globals.css";
import { ConvexClientProvider } from "@/components/convex-provider";
import { SiteNav } from "@/components/site-nav";

const playfair = Playfair_Display({
  variable: "--font-playfair",
  subsets: ["latin"],
  weight: ["400", "600", "700"],
});

const ibmMono = IBM_Plex_Mono({
  variable: "--font-ibm-mono",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
});

const barlow = Barlow_Condensed({
  variable: "--font-barlow",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
});

export const metadata: Metadata = {
  title: "OpenFire — The Claw",
  description: "An AI agent that autonomously fires employees via email.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="en"
      className={`${playfair.variable} ${ibmMono.variable} ${barlow.variable} h-full`}
    >
      <body className="min-h-full flex flex-col antialiased selection:bg-[#b8291e]/30">
        <ConvexClientProvider>
          <div className="grain pointer-events-none fixed inset-0 -z-10" aria-hidden />
          <div className="bg-layer pointer-events-none fixed inset-0 -z-20" aria-hidden />
          <SiteNav />
          <main className="flex-1 mx-auto max-w-6xl w-full px-6 py-10">
            {children}
          </main>
          <footer className="border-t border-[#2e2824] py-4 text-center text-[9px] tracking-[0.25em] text-[#3a3530] font-mono uppercase">
            Openfire Protocol · Clearance: Executive · The Claw Never Sleeps
          </footer>
        </ConvexClientProvider>
      </body>
    </html>
  );
}
