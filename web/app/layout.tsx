import type { Metadata } from "next";
import Link from "next/link";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Ad Break Planner",
  description: "Context-aware ad break placement for Bengali dramas",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col">
        <header className="border-b border-black/10 dark:border-white/10">
          <div className="mx-auto max-w-6xl px-4 py-3 flex items-center gap-3">
            <Link href="/" className="font-semibold tracking-tight">
              Ad Break Planner
            </Link>
            <span className="text-sm opacity-60">context-aware ad placement</span>
          </div>
        </header>
        <main className="mx-auto w-full max-w-6xl px-4 py-6 flex-1">{children}</main>
      </body>
    </html>
  );
}
