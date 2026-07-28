import type { Metadata } from 'next';
import './globals.css';
import { Geist } from 'next/font/google';
import { ThemeProvider } from '@ably-ai-demos/frontend';

const geist = Geist({ subsets: ['latin'], variable: '--font-sans' });

export const metadata: Metadata = {
  title: 'Ably AI — Client Session Demo',
  description: 'Streaming chat over Ably with the AI Transport ClientSession API',
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
