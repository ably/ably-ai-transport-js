import type { Metadata } from 'next';
import './globals.css';
import { Geist } from 'next/font/google';
import { ThemeProvider } from '@ably-ai-demos/frontend';

const geist = Geist({ subsets: ['latin'], variable: '--font-sans' });

export const metadata: Metadata = {
  title: 'Ably AI — Temporal Agent Demo',
  description: 'A durable, Temporal-driven agent over the Ably AI Transport',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={geist.variable}
    >
      <body className="bg-background text-foreground antialiased">
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}
