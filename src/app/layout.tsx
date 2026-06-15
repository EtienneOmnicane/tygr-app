import type { Metadata } from "next";
import { Geist, Instrument_Sans, JetBrains_Mono } from "next/font/google";
import "./globals.css";

// Typographies — UI_GUIDELINES §0 (source de vérité).
// Instrument Sans : UI & display (texte, titres, nav, boutons).
const instrumentSans = Instrument_Sans({
  variable: "--font-instrument-sans",
  subsets: ["latin"],
  display: "swap",
});

// Geist (tabular-nums) : OBLIGATOIRE sur tout montant, axe de graphe et
// cellule numérique — pilier de la clarté financière (§0, §2.1, §6.2).
const geist = Geist({
  variable: "--font-geist",
  subsets: ["latin"],
  display: "swap",
});

// JetBrains Mono : identifiants techniques (HMAC du panneau audit, §0/§4.3).
const jetbrainsMono = JetBrains_Mono({
  variable: "--font-jetbrains-mono",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "TYGR — Trésorerie",
  description:
    "Plateforme de gestion de trésorerie multi-entités (Open Banking Omni-FI)",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="fr"
      className={`${instrumentSans.variable} ${geist.variable} ${jetbrainsMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
