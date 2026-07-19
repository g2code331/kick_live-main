import { createContext, useContext, useState, useCallback, ReactNode } from 'react';
import { CheckCircle, XCircle, Info, X } from 'lucide-react';

interface Toast {
  id: string;
  type: 'success' | 'error' | 'info';
  message: string;
}

interface ToastContextType {
  success: (msg: string) => void;
  error: (msg: string) => void;
  info: (msg: string) => void;
}

const ToastContext = createContext<ToastContextType | undefined>(undefined);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const addToast = useCallback((type: Toast['type'], message: string) => {
    const id = Math.random().toString(36).slice(2);
    setToasts(prev => [...prev, { id, type, message }]);
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 4000);
  }, []);

  const remove = (id: string) => setToasts(prev => prev.filter(t => t.id !== id));

  return (
    <ToastContext.Provider value={{
      success: (msg) => addToast('success', msg),
      error: (msg) => addToast('error', msg),
      info: (msg) => addToast('info', msg),
    }}>
      {children}
      {/* Toast Renderer */}
      <div className="fixed bottom-6 right-6 z-[9999] flex flex-col gap-3 pointer-events-none">
        {toasts.map(toast => (
          <div
            key={toast.id}
            className={`pointer-events-auto flex items-center gap-3 px-5 py-4 rounded-2xl shadow-2xl border backdrop-blur-xl font-bold text-sm max-w-sm animate-in slide-in-from-right-4 duration-300 ${
              toast.type === 'success'
                ? 'bg-brand-green/20 border-brand-green/40 text-white'
                : toast.type === 'error'
                ? 'bg-red-500/20 border-red-500/40 text-white'
                : 'bg-white/10 border-white/20 text-white'
            }`}
          >
            {toast.type === 'success' && <CheckCircle size={18} className="text-brand-green shrink-0" />}
            {toast.type === 'error' && <XCircle size={18} className="text-red-400 shrink-0" />}
            {toast.type === 'info' && <Info size={18} className="text-brand-blue shrink-0" />}
            <span className="flex-1">{toast.message}</span>
            <button onClick={() => remove(toast.id)} className="p-1 hover:opacity-60 transition-opacity">
              <X size={14} />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within ToastProvider');
  return ctx;
}
