import { ArrowLeft } from 'lucide-react';
import type { ReactNode } from 'react';

/**
 * The full-page shell every admin sub-screen renders inside.
 *
 * The admin panel used to open its editors, wizards and settings as centred overlay cards on a dimmed
 * backdrop. This replaces that pattern: each screen is its own page with a real header, a back button
 * that returns to where the user came from, and normal document scroll — no `fixed inset-0`, no
 * backdrop, no trapped focus. `onBack` is what the previous overlay's `onClose` did.
 */
export default function AdminPageShell({
  title,
  subtitle,
  icon,
  onBack,
  backLabel = 'Back',
  actions,
  children,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  icon?: ReactNode;
  onBack: () => void;
  backLabel?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="animate-in">
      {/* Sticky page header with the back button */}
      <div className="sticky top-0 z-20 -mx-4 lg:-mx-10 px-4 lg:px-10 py-4 mb-6 lg:mb-8 glass border-b border-white/10 backdrop-blur-xl">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 lg:gap-4 min-w-0">
            <button
              onClick={onBack}
              className="shrink-0 flex items-center gap-2 px-3 py-2 rounded-xl bg-white/5 hover:bg-white/10 border border-white/10 text-xs font-black uppercase tracking-widest transition-colors"
            >
              <ArrowLeft size={16} /> <span className="hidden sm:inline">{backLabel}</span>
            </button>
            {icon && (
              <div className="hidden sm:flex w-11 h-11 rounded-2xl bg-white/5 border border-white/10 items-center justify-center text-brand-green shrink-0">
                {icon}
              </div>
            )}
            <div className="min-w-0">
              <h1 className="text-lg lg:text-2xl font-black italic uppercase tracking-tighter leading-none truncate">{title}</h1>
              {subtitle && <p className="text-white/40 text-[10px] lg:text-xs uppercase tracking-widest font-bold mt-1 truncate">{subtitle}</p>}
            </div>
          </div>
          {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
        </div>
      </div>

      {children}
    </div>
  );
}
