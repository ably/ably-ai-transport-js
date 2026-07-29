import type { Metadata } from 'next';
import './globals.css';
import { Geist } from 'next/font/google';
import { ThemeProvider } from '@ably-ai-demos/frontend/theme-provider';

const geist = Geist({ subsets: ['latin'], variable: '--font-sans' });

export const metadata: Metadata = {
  title: 'Ably AI — OpenAI Responses Demo',
  description: 'Streaming chat over Ably with the AI Transport ClientSession API and the OpenAI Responses codec',
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
