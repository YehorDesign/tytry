import type { Metadata } from "next";
import { Unbounded, Golos_Text, JetBrains_Mono } from "next/font/google";
import "./globals.css";

const display = Unbounded({
  subsets: ["latin", "cyrillic"],
  weight: ["500", "700", "900"],
  variable: "--font-display",
});

const body = Golos_Text({
  subsets: ["latin", "cyrillic"],
  weight: ["400", "500", "600"],
  variable: "--font-body",
});

const mono = JetBrains_Mono({
  subsets: ["latin", "cyrillic"],
  weight: ["400", "600"],
  variable: "--font-mono",
});

export const metadata: Metadata = {
  title: "ТИТРИ — video captions",
  description: "Local styled-captions generator: Deepgram + Remotion",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="uk">
      <body className={`${display.variable} ${body.variable} ${mono.variable}`}>
        {children}
      </body>
    </html>
  );
}
