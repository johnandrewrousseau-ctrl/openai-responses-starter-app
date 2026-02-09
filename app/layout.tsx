import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";
import ThemeInit from "@/components/theme-init";

const geistSans = localFont({
  src: "./fonts/GeistVF.woff",
  variable: "--font-geist-sans",
  weight: "100 900",
});
const geistMono = localFont({
  src: "./fonts/GeistMonoVF.woff",
  variable: "--font-geist-mono",
  weight: "100 900",
});

export const metadata: Metadata = {
  title: "Responses starter app",
  description: "Starter app for the OpenAI Responses API",
  icons: {
    icon: "/openai_logo.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className={`${geistSans.variable} ${geistMono.variable} antialiased`}>
        <ThemeInit />
        <div className="flex h-screen w-full flex-col bg-stone-100 text-stone-900 dark:bg-stone-950 dark:text-stone-100">
          <main className="h-full">{children}</main>
        </div>
      </body>
    </html>
  );
}
