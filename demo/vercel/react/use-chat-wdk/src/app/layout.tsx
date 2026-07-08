import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Ably AI Transport — Durable WDK Demo',
  description: 'AIT durable sessions running on Vercel Workflows',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-zinc-950 text-zinc-100 antialiased">{children}</body>
    </html>
  );
}
