import type { Metadata } from 'next';
import './globals.css';
import { Geist } from 'next/font/google';

const geist = Geist({ subsets: ['latin'], variable: '--font-sans' });

export const metadata: Metadata = {
  title: 'Ably AI — Client Session Demo',
  description: 'Streaming chat over Ably with the AI Transport ClientSession API',
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
