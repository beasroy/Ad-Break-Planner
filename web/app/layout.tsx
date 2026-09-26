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
  title: "Hoichoi Ad Break Planner",
  description: "Context-aware ad break placement for Bengali dramas",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col bg-background text-foreground">
        <header className="sticky top-0 z-10 border-b border-border bg-background/90 backdrop-blur">
          <div className="mx-auto flex max-w-6xl items-center gap-3 px-4 py-4">
            <Link href="/" className="font-semibold tracking-[0.2em] uppercase text-accent-strong">
              hoichoi
            </Link>
            <span className="hidden h-4 w-px bg-border sm:block" />
            <span className="text-sm text-muted">ad break planner</span>
          </div>
        </header>
        <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8">{children}</main>
      </body>
    </html>
  );
}
