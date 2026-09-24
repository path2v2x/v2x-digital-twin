import type { Metadata } from "next";
import { Barlow, Bricolage_Grotesque, Chakra_Petch } from "next/font/google";
import { Toaster } from "sonner";
import "./globals.css";

const display = Bricolage_Grotesque({
  subsets: ["latin"],
  variable: "--font-display",
  weight: ["400", "500", "600", "700", "800"],
  display: "swap",
});

const body = Barlow({
  subsets: ["latin"],
  variable: "--font-body",
  weight: ["400", "500", "600"],
  display: "swap",
});

const heavy = Chakra_Petch({
  subsets: ["latin"],
  variable: "--font-heavy",
  weight: ["600", "700"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "V2X Digital Twin",
  description: "Live digital twin of the Richmond Field Station V2X intersection.",
  applicationName: "V2X Digital Twin",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`dark ${display.variable} ${body.variable} ${heavy.variable}`}>
      <body className="h-svh overflow-hidden">
        {children}
        <Toaster theme="dark" richColors position="bottom-right" />
      </body>
    </html>
  );
}
