import type { Metadata } from 'next';
import '@fontsource/eb-garamond/400.css';
import '@fontsource/eb-garamond/400-italic.css';
import '@fontsource/jetbrains-mono/400.css';
import './globals.css';

export const metadata: Metadata = {
  title: 'PACMAN 4D — On the Observability of Maze-Bound Spectres',
  description: 'A quantum-mechanical rebuild of classic Pacman where observation collapses ghost wavefunctions.',
  openGraph: {
    title: 'PACMAN 4D',
    description: 'On the Observability of Maze-Bound Spectres',
    type: 'website',
    images: [{ url: '/og.png', width: 1731, height: 909, alt: 'PACMAN 4D quantum maze experiment' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'PACMAN 4D',
    description: 'On the Observability of Maze-Bound Spectres',
    images: ['/og.png'],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
