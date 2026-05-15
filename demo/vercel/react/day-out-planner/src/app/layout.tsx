import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Ably AI — Day out planner',
  description: 'Group chat with Bernard, a planning agent that writes to a shared itinerary',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-zinc-950 text-zinc-100 antialiased">{children}</body>
    </html>
  );
}
