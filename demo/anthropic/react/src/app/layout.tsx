import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Ably AI — Anthropic Agent SDK Demo',
  description: 'Anthropic Agent SDK demo with Ably transport and debug pane',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-zinc-950 text-zinc-100 antialiased">{children}</body>
    </html>
  );
}
