// The backend serves only API routes; this layout exists because Next.js requires a root layout.
export const metadata = { title: "Riddlebound API", robots: { index: false } };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
