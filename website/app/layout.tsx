import type { Metadata, Viewport } from 'next'
import { Inter, JetBrains_Mono } from 'next/font/google'
import { Analytics } from '@vercel/analytics/next'
import './globals.css'

const _inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
})

const _jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-jetbrains-mono',
})

export const metadata: Metadata = {
  title: 'Mandible - Agent coordination through environmental signals',
  description:
    'A universal stigmergy framework. Agents coordinate by reading from and writing to a shared environment, not by talking to each other.',
  openGraph: {
    title: 'Mandible - Agent coordination through environmental signals',
    description: 'Stop wiring agents together. Let them self-organize.',
    type: 'website',
    url: 'https://mandible.dev',
  },
}

export const viewport: Viewport = {
  themeColor: '#101014',
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en" className={`${_inter.variable} ${_jetbrainsMono.variable}`}>
      <body className="font-sans antialiased overflow-x-hidden">
        {children}
        <Analytics />
      </body>
    </html>
  )
}
