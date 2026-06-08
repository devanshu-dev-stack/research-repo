import type { Metadata } from "next";
import { TRPCProvider } from "@/lib/trpc";
import "./globals.css";

export const metadata: Metadata = {
  title: "Research Repository",
  description: "Product research ingestion, tagging, and insight management.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        {/* Brand fonts (Copernicus + DK Formosa) embedded as base64 */}
        <link rel="stylesheet" href="/brand_fonts.css" />
      </head>
      <body>
        <TRPCProvider>{children}</TRPCProvider>
      </body>
    </html>
  );
}
