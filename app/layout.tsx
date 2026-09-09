import "./globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Playlist Challenge",
  description: "Eine Song-pro-Interpret Playlist Challenge",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="en"><body>{children}</body></html>;
}
