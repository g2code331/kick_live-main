import { assetUrl } from "../../lib/app-shell.ts";
import { useState } from 'react';
import { Eye, EyeOff, Loader2, UserPlus, Shield, Users, Newspaper, Heart, Check, Smartphone, User as UserIcon } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { submitAccessRequest } from '../../lib/access';
import { log } from '../../lib/log';

interface SignupPageProps {
  onNavigate: (page: string) => void;
}

type RequestedRole = 'team_manager' | 'media';

/**
 * Public registration creates a FAN account — nothing else.
 *
 * This file used to hold `const rolePasswords = { team_manager: 'mejojO', media: 'wojojO',
 * admin: 'isjojO' }` and gate privileged signups on it client-side (audit F-01/F-02): the "secret"
 * ships inside the bundle, and the role it unlocked was then written from the browser into
 * `profiles.role`. Anyone could read the map and mint an admin.
 *
 * Now: the account is always a fan, and Manager/Media are *applications* — ticking one queues a
 * request an admin approves in User Control. `admin` cannot be requested at all. The database holds
 * the real rule (RLS + `kicklive_request_access`); this form only decides how much of the queueing
 * work a human has to do.
 */
export default function SignupPage({ onNavigate }: SignupPageProps) {
  const { signUp } = useAuth();
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [requestedRole, setRequestedRole] = useState<RequestedRole | null>(null);
  const [reason, setReason] = useState('');
  const [requestQueued, setRequestQueued] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const validate = (): string | null => {
    if (username.trim().length < 3) return 'Username needs at least 3 characters';
    if (username.trim().length > 32) return 'Username is too long (32 characters max)';
    if (!/^[A-Za-z0-9 ._'-]+$/.test(username.trim())) return 'Username has unsupported characters';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.trim())) return 'Enter a valid email address';
    if (phone.length < 9 || phone.length > 15) return 'Enter a full phone number (9–15 digits)';
    if (password.length < 8) return 'Password must be at least 8 characters';
    if (password !== confirmPassword) return 'Passwords do not match';
    if (requestedRole && reason.trim().length < 10) {
      return 'Add a sentence about your club or newsroom so an admin can decide';
    }
    return null;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const problem = validate();
    if (problem) {
      setError(problem);
      return;
    }

    setLoading(true);

    const { error: signUpError } = await signUp(email.trim().toLowerCase(), password, username.trim(), phone);

    if (signUpError) {
      setError(signUpError);
      setLoading(false);
      return;
    }

    // The account exists by now, so a failed request must not look like a failed signup: log it,
    // tell the user, and let them retry from their profile later.
    let queued = false;
    if (requestedRole) {
      const { ok, error: requestError } = await submitAccessRequest(requestedRole, reason);
      if (!ok) log.warn('Access request could not be queued:', requestError);
      queued = ok;
      setRequestQueued(ok);
    }

    setSuccess(true);
    setLoading(false);
    setTimeout(() => {
      onNavigate('login');
    }, queued ? 4000 : 2000);
  };

  if (success) {
    return (
      <div className="min-h-screen flex items-center justify-center px-4 py-12">
        <div className="w-full max-w-md text-center">
          <div className="w-24 h-24 gradient-green rounded-full flex items-center justify-center mx-auto mb-6">
            <Check size={40} className="text-black" />
          </div>
          <h1 className="text-3xl font-black italic uppercase tracking-tighter mb-4">
            Account Created!
          </h1>
          <p className="text-white/40 mb-2">
            {requestQueued
              ? 'Your fan account is ready. The access request is queued for an admin to review.'
              : 'Success! Redirecting you to the login page...'}
          </p>
          {requestQueued && (
            <p className="text-[10px] text-white/30 uppercase tracking-widest font-black mb-6">
              You will be notified once it is approved
            </p>
          )}
          <div className="flex justify-center">
            <Loader2 size={24} className="animate-spin text-brand-green" />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-4 py-12">
      <div className="w-full max-w-2xl">
        {/* Logo */}
        <div className="text-center mb-8">
          <div className="w-16 h-16 mx-auto mb-4">
            <img src={assetUrl("kicklive-icon.png")} alt="KickLive" className="w-full h-full object-contain" />
          </div>
          <h1 className="text-3xl font-black italic uppercase tracking-tighter">
            Join KickLive
          </h1>
          <p className="text-white/40 text-sm mt-2">The Ultimate Tournament Management Platform</p>
        </div>

        {/* Signup Form */}
        <form onSubmit={handleSubmit} className="glass rounded-3xl p-8 space-y-8">
          {error && (
            <div className="bg-brand-red/10 border border-brand-red/30 text-brand-red px-4 py-3 rounded-xl text-sm font-medium">
              {error}
            </div>
          )}

          {/* Account type: fans self-register, everything else is granted */}
          <div className="space-y-4">
            <label className="text-xs font-black uppercase tracking-widest text-white/40 text-center block">
              SELECT YOUR ROLE
            </label>

            <div className="flex flex-col gap-4">
              {/* Fan Role - what this form actually creates */}
              <div className="w-full p-6 rounded-2xl border-2 border-brand-blue bg-brand-blue/10 scale-[1.02] text-left flex items-center justify-between">
                <div className="flex items-center gap-6">
                  <div className="w-16 h-16 rounded-2xl flex items-center justify-center bg-brand-blue text-white">
                    <Heart size={32} />
                  </div>
                  <div>
                    <h3 className="text-xl font-black uppercase italic tracking-tighter">Fan</h3>
                    <p className="text-xs text-white/40 mt-1 max-w-xs">Follow matches, make predictions, and engage with the community</p>
                  </div>
                </div>
                <div className="w-6 h-6 bg-brand-blue rounded-full flex items-center justify-center"><Check size={14} /></div>
              </div>

              {/* Optional access requests — reviewed by an admin, never applied by this form */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {([
                  { id: 'team_manager', label: 'Team Manager', icon: <Users size={20} />, blurb: 'Register a club and manage its squad' },
                  { id: 'media', label: 'Media', icon: <Newspaper size={20} />, blurb: 'Publish reports and match media' },
                ] as const).map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    onClick={() => setRequestedRole(requestedRole === option.id ? null : option.id)}
                    aria-pressed={requestedRole === option.id}
                    className={`p-4 rounded-xl border-2 transition-all text-center flex flex-col items-center gap-2 ${
                      requestedRole === option.id
                        ? 'border-brand-green bg-white/10'
                        : 'border-white/5 bg-white/5 hover:border-white/10'
                    }`}
                  >
                    <div className={`p-3 rounded-lg ${requestedRole === option.id ? 'bg-brand-green text-black' : 'bg-white/5 text-white/40'}`}>
                      {option.icon}
                    </div>
                    <span className="text-xs font-black uppercase tracking-widest">{option.label}</span>
                    <span className="text-[9px] text-white/30">{option.blurb}</span>
                  </button>
                ))}
              </div>
            </div>

            {requestedRole ? (
              <div className="space-y-2 animate-in slide-in-from-top-4 duration-300">
                <label className="text-[10px] font-black uppercase tracking-widest text-white/40">
                  Why do you need {requestedRole === 'media' ? 'media access' : 'manager access'}?
                </label>
                <textarea
                  value={reason}
                  onChange={(e) => setReason(e.target.value.slice(0, 1000))}
                  rows={3}
                  placeholder="Club, league or newsroom you represent, and how you were invited"
                  className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-sm text-white placeholder:text-white/20 focus:outline-none focus:border-white/30 transition-colors resize-none"
                />
                <p className="text-[9px] text-white/30 leading-relaxed">
                  Your account is created as a fan straight away. An admin reviews the request and
                  grants the access afterwards — it is not applied by this form.
                </p>
              </div>
            ) : (
              <p className="text-[9px] text-white/30 text-center leading-relaxed">
                Signing up creates a fan account. Team Manager and Media access are granted by an
                admin after review.
              </p>
            )}

            {/* Admin is not obtainable here, and saying so beats people asking */}
            <div className="flex items-start gap-3 rounded-xl border border-white/5 bg-white/[0.02] px-4 py-3">
              <Shield size={16} className="text-white/20 mt-0.5 shrink-0" />
              <p className="text-[9px] text-white/30 leading-relaxed">
                Administrator accounts are never issued through registration. They are created by an
                existing admin.
              </p>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {/* User Info */}
            <div className="space-y-4">
              <div className="space-y-2">
                <label className="text-[10px] font-black uppercase tracking-widest text-white/40 flex items-center gap-2">
                   <UserIcon size={12}/> Username
                </label>
                <input
                  type="text"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="Choose a username"
                  required
                  maxLength={32}
                  className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-white placeholder:text-white/20 focus:outline-none focus:border-brand-green/50 transition-colors"
                />
              </div>

              <div className="space-y-2">
                <label className="text-[10px] font-black uppercase tracking-widest text-white/40 flex items-center gap-2">
                   <Smartphone size={12}/> Telephone
                </label>
                <input
                  type="tel"
                  value={phone}
                  onChange={(e) => {
                    const val = e.target.value.replace(/\D/g, '');
                    setPhone(val);
                  }}
                  placeholder="0XX XXX XXXX"
                  required
                  maxLength={15}
                  className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-white placeholder:text-white/20 focus:outline-none focus:border-brand-green/50 transition-colors"
                />
              </div>

              <div className="space-y-2">
                <label className="text-[10px] font-black uppercase tracking-widest text-white/40">
                  Email Address
                </label>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="email@example.com"
                  required
                  className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-white placeholder:text-white/20 focus:outline-none focus:border-brand-green/50 transition-colors"
                />
              </div>
            </div>

            {/* Password Info */}
            <div className="space-y-4">
              <div className="space-y-2">
                <label className="text-[10px] font-black uppercase tracking-widest text-white/40">
                  Password
                </label>
                <div className="relative">
                  <input
                    type={showPassword ? 'text' : 'password'}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Min 8 characters"
                    required
                    minLength={8}
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

              <div className="space-y-2">
                <label className="text-[10px] font-black uppercase tracking-widest text-white/40">
                  Confirm Password
                </label>
                <input
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  placeholder="Repeat password"
                  required
                  className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-white placeholder:text-white/20 focus:outline-none focus:border-brand-green/50 transition-colors"
                />
              </div>

              <div className="pt-2">
                <p className="text-[9px] text-white/20 leading-relaxed">
                  * By joining, you agree to follow the Rx Live community guidelines and sportsmanship rules.
                </p>
              </div>
            </div>
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full gradient-green text-black font-black uppercase tracking-widest py-5 rounded-2xl flex items-center justify-center gap-3 hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed shadow-[0_0_30px_rgba(57,255,20,0.2)]"
          >
            {loading ? (
              <Loader2 size={24} className="animate-spin" />
            ) : (
              <>
                <UserPlus size={24} />
                Create Account
              </>
            )}
          </button>

          <div className="text-center">
            <p className="text-white/40 text-xs font-bold uppercase tracking-widest">
              Already a member?{' '}
              <button
                type="button"
                onClick={() => onNavigate('login')}
                className="text-brand-green hover:underline ml-1"
              >
                Login
              </button>
            </p>
          </div>
        </form>
      </div>
    </div>
  );
}
