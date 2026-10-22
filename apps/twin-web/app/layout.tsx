import type { Metadata } from "next";
import { Barlow, Bricolage_Grotesque } from "next/font/google";
import "./globals.css";

const display = Bricolage_Grotesque({
  subsets: ["latin"],
  variable: "--font-display",
  weight: "600",
  display: "swap",
});

const body = Barlow({
  subsets: ["latin"],
  variable: "--font-body",
  weight: ["400", "600"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "Richmond Field Station detections",
  description: "Detections from the Richmond Field Station V2X cameras, with their recorded footage.",
  applicationName: "V2X detections",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${display.variable} ${body.variable}`}>
      <body className="h-svh overflow-hidden">{children}</body>
    </html>
  );
}
