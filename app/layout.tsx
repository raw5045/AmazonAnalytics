import type { Metadata, Viewport } from "next";
import { ClerkProvider } from "@clerk/nextjs";
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
  metadataBase: new URL(process.env.APP_PUBLIC_URL ?? "https://keywordquarry.com"),
  title: {
    default: "KeywordQuarry",
    template: "%s · KeywordQuarry",
  },
  description:
    "Find high-demand, low-competition Amazon keywords. Weekly-fresh search data, fake-volume detection, and exact leaf-category mapping.",
  openGraph: {
    siteName: "KeywordQuarry",
    type: "website",
  },
};

export const viewport: Viewport = {
  themeColor: "#0B1E3A",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <ClerkProvider afterSignOutUrl="/">
      <html
        lang="en"
        className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
      >
        <body className="min-h-full flex flex-col">{children}</body>
      </html>
    </ClerkProvider>
  );
}
