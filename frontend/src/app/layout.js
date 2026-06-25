import { Inter } from 'next/font/google';
import './globals.css';
import QueryProvider from '../components/QueryProvider';
import { Toaster } from 'react-hot-toast';

const inter = Inter({ subsets: ['latin'], variable: '--font-inter' });

export const metadata = {
  title: 'NUWACO WMS - Water Meter Management',
  description: 'LoRaWAN Water Meter Management System'
};

export default function RootLayout({ children }) {
  return (
    <html lang="en" className="dark">
      <body className={`${inter.variable} font-sans bg-slate-950 text-slate-100 antialiased`}>
        <QueryProvider>
          {children}
          <Toaster position="top-right" toastOptions={{ style: { background: '#1e293b', color: '#f1f5f9', border: '1px solid #334155' }, success: { iconTheme: { primary: '#7ED957', secondary: '#fff' } }, error: { iconTheme: { primary: '#ef4444', secondary: '#fff' } } }} />
        </QueryProvider>
      </body>
    </html>
  );
}
