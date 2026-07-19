import { useState, useEffect } from 'react';
import { Mail, ArrowLeft, Loader2, CheckCircle } from 'lucide-react';
import { supabase } from '../../lib/supabase';

interface ForgotPasswordPageProps {
  onNavigate: (page: string) => void;
}

export default function ForgotPasswordPage({ onNavigate }: ForgotPasswordPageProps) {
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const { error } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: window.location.origin + '/login',
      });

      if (error) throw error;

      setSuccess(true);
    } catch (err: any) {
      setError(err.message || 'Failed to send reset email');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-brand-bg flex items-center justify-center px-4">
      <div className="w-full max-w-md">
        {/* Back Button */}
        <button
          onClick={() => onNavigate('login')}
          className="flex items-center gap-2 text-white/40 hover:text-white transition-colors mb-8"
        >
          <ArrowLeft size={20} />
          <span className="text-sm font-bold">Back to Login</span>
        </button>

        {/* Logo */}
        <div className="text-center mb-8">
          <div className="w-20 h-20 mx-auto mb-6">
            <img src="/kicklive-icon.png" alt="KickLive" className="w-full h-full object-contain" />
          </div>
          <h1 className="text-3xl font-black italic uppercase tracking-tighter">
            Forgot Password?
          </h1>
          <p className="text-white/40 text-sm mt-2">
            No worries, we'll send you reset instructions
          </p>
        </div>

        {success ? (
          <div className="glass rounded-3xl p-8 text-center space-y-6 animate-in zoom-in">
            <div className="w-20 h-20 bg-brand-green/20 rounded-full flex items-center justify-center mx-auto">
              <CheckCircle className="text-brand-green" size={40} />
            </div>
            <div>
              <h2 className="text-xl font-black uppercase mb-2">Check Your Email</h2>
              <p className="text-white/60 text-sm">
                We've sent password reset instructions to:
              </p>
              <p className="text-brand-green font-bold mt-2">{email}</p>
            </div>
            <button
              onClick={() => onNavigate('login')}
              className="w-full gradient-green text-black font-black uppercase tracking-widest py-4 rounded-xl"
            >
              Back to Login
            </button>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="glass rounded-3xl p-8 space-y-6">
            {error && (
              <div className="bg-brand-red/10 border border-brand-red/30 text-brand-red px-4 py-3 rounded-xl text-sm font-medium">
                {error}
              </div>
            )}

            <div className="space-y-2">
              <label className="text-xs font-black uppercase tracking-widest text-white/40">
                Email Address
              </label>
              <div className="relative">
                <Mail className="absolute left-4 top-1/2 -translate-y-1/2 text-white/20" size={20} />
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="Enter your email"
                  required
                  className="w-full bg-white/5 border border-white/10 rounded-xl pl-12 pr-4 py-3 text-white placeholder:text-white/20 focus:outline-none focus:border-brand-green/50 transition-colors"
                />
              </div>
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full gradient-green text-black font-black uppercase tracking-widest py-4 rounded-xl flex items-center justify-center gap-3 hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {loading ? (
                <>
                  <Loader2 size={20} className="animate-spin" />
                  Sending...
                </>
              ) : (
                'Send Reset Link'
              )}
            </button>

            <div className="text-center pt-4 border-t border-white/10">
              <p className="text-white/40 text-sm">
                Remember your password?{' '}
                <button
                  type="button"
                  onClick={() => onNavigate('login')}
                  className="text-brand-green font-bold hover:underline"
                >
                  Sign In
                </button>
              </p>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
