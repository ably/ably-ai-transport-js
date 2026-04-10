export const metadata = { title: 'useChat edit/regenerate demo' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: 'system-ui, sans-serif', margin: 0, background: '#111', color: '#e4e4e7' }}>
        {children}
      </body>
    </html>
  );
}
