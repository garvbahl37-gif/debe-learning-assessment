import type { Metadata } from "next";

import "./globals.css";

export const metadata: Metadata = {
  title: "Debe · Parent portal",
  description:
    "Parent-facing widget for viewing and rescheduling upcoming tutoring sessions.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    // `lang` matters for the `Intl` formatting used throughout, and for screen
    // reader pronunciation of the date strings.
    <html lang="en-GB">
      <body className="min-h-dvh antialiased">{children}</body>
    </html>
  );
}
