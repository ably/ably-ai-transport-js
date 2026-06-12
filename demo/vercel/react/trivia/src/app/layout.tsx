import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Ably Trivia Night',
  description: 'AI-refereed multiplayer trivia over Ably AI Transport and LiveObjects',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-zinc-950 text-zinc-100 antialiased">{children}</body>
    </html>
  );
}
