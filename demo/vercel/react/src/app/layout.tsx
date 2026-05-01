import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Ably AI — Basic Chat Demo',
  description: 'Basic chat using ClientSession and AgentSession over Ably.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-zinc-950 text-zinc-100 antialiased">{children}</body>
    </html>
  );
}
