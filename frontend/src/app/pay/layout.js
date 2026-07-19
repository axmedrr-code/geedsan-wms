import { Droplets } from 'lucide-react';

export const metadata = {
  title: 'NUWACO — Online Payment Portal',
  description: 'Pay your water bill online',
};

export default function PayLayout({ children }) {
  return (
    <div className="min-h-screen bg-slate-950 flex flex-col">
      <header className="border-b border-slate-800 bg-slate-900/60 backdrop-blur-sm px-4 py-3 flex-shrink-0">
        <div className="max-w-2xl mx-auto flex items-center gap-3">
          <div className="w-8 h-8 bg-primary-500/20 border border-primary-500/30 rounded-lg flex items-center justify-center flex-shrink-0">
            <Droplets className="w-4 h-4 text-primary-400" />
          </div>
          <div>
            <p className="font-bold text-white text-sm">NUWACO</p>
            <p className="text-slate-500 text-xs">Online Payment Portal</p>
          </div>
          <a
            href="/login"
            className="ml-auto text-xs text-slate-500 hover:text-slate-300 transition-colors"
          >
            Staff Login →
          </a>
        </div>
      </header>
      <main className="flex-1 flex flex-col">{children}</main>
      <footer className="border-t border-slate-800/60 py-4 px-4 text-center">
        <p className="text-slate-600 text-xs">
          NUWACO Water Utility &mdash; Secure Online Payment &mdash; SSL Encrypted
        </p>
      </footer>
    </div>
  );
}
