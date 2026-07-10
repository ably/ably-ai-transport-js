import type { Metadata } from 'next';
import './globals.css';
import { Geist } from 'next/font/google';

const geist = Geist({ subsets: ['latin'], variable: '--font-sans' });

export const metadata: Metadata = {
  title: 'Ably AI — ClientSession + Temporal Demo',
  description: 'A durable, Temporal-driven agent over the Ably AI Transport ClientSession API',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={`dark ${geist.variable}`}
    >
      <body className="bg-background text-foreground antialiased">{children}</body>
    </html>
  );
}
