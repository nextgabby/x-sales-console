import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Providers } from "./providers";
import { DemoBanner } from "./demo-banner";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  /**
   * Deliberately not led by "X". The sign-in page renders on the client, so a crawler that does not
   * run scripts sees this title and almost nothing else — a brand name alone on an unaffiliated
   * host, which is how Google Safe Browsing came to block the deployment as a phishing page.
   */
  title: "Ads Sales Console",
  description: "Campaign performance for the advertiser accounts you have access to.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col bg-canvas text-ink">
        <DemoBanner />
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
