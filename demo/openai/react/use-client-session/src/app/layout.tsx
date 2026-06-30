import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Ably AI — OpenAI Responses Demo',
  description: 'Streaming chat over Ably with the AI Transport ClientSession API and the OpenAI Responses codec',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-zinc-950 text-zinc-100 antialiased">{children}</body>
    </html>
  );
}
