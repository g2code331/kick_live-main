import { useState } from 'react';
import { Eye, EyeOff, LogIn, ArrowLeft } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { UserRole } from '../../lib/supabase';
import AppBackground from '../../components/AppBackground';

interface LoginPageProps {
  onNavigate: (page: string) => void;
  showBackButton?: boolean;
}

export default function LoginPage({ onNavigate, showBackButton = false }: LoginPageProps) {
  const { signIn } = useAuth();
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);

    // Determine if identifier is email, phone, or username
    let email = identifier;
    let phone: string | undefined = undefined;
    
    // Check if it's a phone number (starts with + or contains only digits/spaces/dashes)
    const cleanIdentifier = identifier.replace(/[\s\-\(\)]/g, '');
    if (/^\+?\d+$/.test(cleanIdentifier)) {
      phone = identifier;
      email = ''; // Supabase requires email field, but we'll use phone
    }

    const { error, role } = await signIn(email, password, phone);

    if (error) {
      setError(error);
      setLoading(false);
      return;
    }

    if (role) {
      navigateToPortal(role);
    }
    setLoading(false);
  };

  const navigateToPortal = (role: UserRole) => {
    // Use hash routing for SPA
    switch (role) {
      case 'admin':
        window.location.hash = '/admin';
        break;
      case 'fan':
        window.location.hash = '/';
        break;
      case 'team_manager':
        window.location.hash = '/team-owner';
        break;
      case 'media':
        window.location.hash = '/media-portal';
        break;
      default:
        window.location.hash = '/';
    }
  };

  return (
    <div className="min-h-screen relative flex items-center justify-center px-4 overflow-hidden">
      <AppBackground />

      {/* Content */}
      <div className="relative z-10 w-full max-w-md">
        {/* Back Button */}
        <button
          onClick={() => window.history.back()}
          className="absolute top-4 left-4 flex items-center gap-2 text-white/60 hover:text-white transition-colors z-20"
        >
          <ArrowLeft size={20} />
          <span className="text-sm font-bold">Back</span>
        </button>

        {/* Logo */}
        <div className="text-center mb-8">
          <div className="w-24 h-24 mx-auto mb-6 rounded-3xl overflow-hidden shadow-2xl shadow-brand-green/20">
            <img src="/kicklive-icon.png" alt="KickLive" className="w-full h-full object-contain" />
          </div>
          <h1 className="text-3xl font-black italic uppercase tracking-tighter text-white">
            Welcome Back
          </h1>
          <p className="text-white/60 text-sm mt-2">Sign in to continue</p>
        </div>

        {/* Login Form */}
        <form onSubmit={handleSubmit} className="glass rounded-3xl p-8 space-y-6">
          {error && (
            <div className="bg-brand-red/10 border border-brand-red/30 text-brand-red px-4 py-3 rounded-xl text-sm font-medium">
              {error}
            </div>
          )}

          <div className="space-y-2">
            <label className="text-xs font-black uppercase tracking-widest text-white/40">
              Username, Email or Phone
            </label>
            <input
              type="text"
              value={identifier}
              onChange={(e) => setIdentifier(e.target.value)}
              placeholder="Enter username, email or phone number"
              required
              className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-white placeholder:text-white/20 focus:outline-none focus:border-brand-green/50 transition-colors"
            />
          </div>

          <div className="space-y-2">
            <label className="text-xs font-black uppercase tracking-widest text-white/40">
              Password
            </label>
            <div className="relative">
              <input
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Enter your password"
                required
                className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-white placeholder:text-white/20 focus:outline-none focus:border-brand-green/50 transition-colors pr-12"
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute right-4 top-1/2 -translate-y-1/2 text-white/40 hover:text-white transition-colors"
              >
                {showPassword ? <EyeOff size={20} /> : <Eye size={20} />}
              </button>
            </div>
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full gradient-green text-black font-black uppercase tracking-widest py-4 rounded-xl flex items-center justify-center gap-3 hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {loading ? (
              <div className="relative w-8 h-8">
                <div className="absolute inset-0 border-2 border-black/30 rounded-full"></div>
                <div className="absolute inset-0 border-2 border-black border-t-transparent rounded-full animate-spin"></div>
                <div className="absolute inset-0 flex items-center justify-center">
                  <span className="text-xs font-black"></span>
                </div>
              </div>
            ) : (
              <>
                <LogIn size={20} />
                Sign In
              </>
            )}
          </button>

          <div className="flex items-center justify-between pt-2">
            <button
              type="button"
              onClick={() => onNavigate('forgot-password')}
              className="text-[10px] text-brand-blue font-bold hover:underline"
            >
              Forgot Password?
            </button>
            <button
              type="button"
              onClick={() => onNavigate('signup')}
              className="text-[10px] text-white/40 font-bold hover:text-white transition-colors flex items-center gap-1"
            >
              No account? <span className="text-brand-green">Sign Up</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
