import type { Metadata } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import './globals.css';

const geistSans = Geist({ variable: '--font-geist-sans', subsets: ['latin'] });
const geistMono = Geist_Mono({ variable: '--font-geist-mono', subsets: ['latin'] });

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3001'),
  title: 'Vaultflow — Vault Automation',
  description: 'Secure, coordinated token automation across independent vault strategies.',
  openGraph: {
    title: 'Vaultflow',
    description: 'Secure vault automation',
    images: ['/og.png'],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Vaultflow',
    description: 'Secure vault automation',
    images: ['/og.png'],
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body className={`${geistSans.variable} ${geistMono.variable}`}>{children}</body></html>;
}
