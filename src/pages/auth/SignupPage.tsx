import { useState } from 'react';
import { Eye, EyeOff, Loader2, UserPlus, Shield, Users, Newspaper, Heart, Lock, Check, Smartphone, User as UserIcon } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { UserRole } from '../../lib/supabase';

interface SignupPageProps {
  onNavigate: (page: string) => void;
}

const rolePasswords: Record<string, string> = {
  'team_manager': 'mejojO',
  'media': 'wojojO',
  'admin': 'isjojO',
};

export default function SignupPage({ onNavigate }: SignupPageProps) {
  const { signUp } = useAuth();
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [role, setRole] = useState<UserRole>('fan');
  const [rolePasswordInput, setRolePasswordInput] = useState('');
  const [showRolePasswordInput, setShowRolePasswordInput] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    // Validate Role Password if not fan
    if (role !== 'fan') {
      if (rolePasswordInput !== rolePasswords[role]) {
        setError(`Incorrect access password for ${role.replace('_', ' ')} role`);
        return;
      }
    }

    if (password !== confirmPassword) {
      setError('Passwords do not match');
      return;
    }

    if (password.length < 6) {
      setError('Password must be at least 6 characters');
      return;
    }

    setLoading(true);

    const { error: signUpError } = await signUp(email, password, username, phone, role);

    if (signUpError) {
      setError(signUpError);
      setLoading(false);
      return;
    }

    setSuccess(true);
    setLoading(false);
    // After 2 seconds, redirect to login
    setTimeout(() => {
      onNavigate('login');
    }, 2000);
  };

  const handleRoleSelect = (selectedRole: UserRole) => {
    if (selectedRole === 'fan') {
      setRole('fan');
      setShowRolePasswordInput(false);
    } else {
      setRole(selectedRole);
      setShowRolePasswordInput(true);
      setRolePasswordInput('');
    }
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
          <p className="text-white/40 mb-8">
            Success! Redirecting you to the login page...
          </p>
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
            <img src="/kicklive-icon.png" alt="KickLive" className="w-full h-full object-contain" />
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

          {/* Role Selection */}
          <div className="space-y-4">
            <label className="text-xs font-black uppercase tracking-widest text-white/40 text-center block">
              SELECT YOUR ROLE
            </label>
            
            <div className="grid grid-cols-2 gap-2 md:flex md:flex-col md:gap-4">
              {/* Fan Role - Featured Big */}
              <button
                type="button"
                onClick={() => handleRoleSelect('fan')}
                className={`w-full col-span-2 md:col-span-1 p-3 md:p-6 rounded-2xl border-2 transition-all text-left flex items-center justify-between group ${
                  role === 'fan'
                    ? 'border-brand-blue bg-brand-blue/10 scale-[1.02]'
                    : 'border-white/10 hover:border-white/20 bg-white/5'
                }`}
              >
                <div className="flex items-center gap-3 md:gap-6">
                  <div className={`w-10 h-10 md:w-16 md:h-16 rounded-xl md:rounded-2xl flex items-center justify-center transition-colors ${
                    role === 'fan' ? 'bg-brand-blue text-white' : 'bg-white/5 text-white/20'
                  }`}>
                    <Heart size={22} className="md:w-8 md:h-8" />
                  </div>
                  <div>
                    <h3 className="text-xl font-black uppercase italic tracking-tighter">Fan</h3>
                    <p className="hidden md:block text-xs text-white/40 mt-1 max-w-xs">Follow matches, make predictions, and engage with the community</p>
                  </div>
                </div>
                {role === 'fan' && <div className="w-6 h-6 bg-brand-blue rounded-full flex items-center justify-center"><Check size={14} /></div>}
              </button>

              {/* Other Roles - Smaller Grid */}
              <div className="col-span-2 grid grid-cols-2 md:grid-cols-3 gap-2 md:gap-4">
                {[
                  { id: 'team_manager', label: 'Manager', icon: <Users size={20} />, color: 'yellow-500' },
                  { id: 'media', label: 'Media', icon: <Newspaper size={20} />, color: 'purple-500' },
                  { id: 'admin', label: 'Admin', icon: <Shield size={20} />, color: 'brand-green' },
                ].map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    onClick={() => handleRoleSelect(option.id as UserRole)}
                    className={`p-2 md:p-4 rounded-xl border-2 transition-all text-center flex flex-col items-center gap-1 md:gap-2 ${
                      role === option.id
                        ? `border-${option.color} bg-white/10`
                        : 'border-white/5 bg-white/5 hover:border-white/10'
                    }`}
                  >
                    <div className={`p-2 md:p-3 rounded-lg ${role === option.id ? `bg-${option.color} text-black` : 'bg-white/5 text-white/40'}`}>
                      {option.icon}
                    </div>
                    <span className="text-xs font-black uppercase tracking-widest">{option.label}</span>
                  </button>
                ))}
              </div>
            </div>

            {/* Role Password Input (Conditional) */}
            {showRolePasswordInput && (
              <div className="animate-in slide-in-from-top-4 duration-300">
                <div className="relative">
                  <div className="absolute left-4 top-1/2 -translate-y-1/2 text-white/20">
                    <Lock size={18} />
                  </div>
                  <div className="absolute left-12 top-2 text-[8px] font-black uppercase tracking-widest text-white/30">
                    Access Password for {role.replace('_', ' ')}
                  </div>
                  <input
                    type="password"
                    value={rolePasswordInput}
                    onChange={(e) => setRolePasswordInput(e.target.value)}
                    placeholder="Enter access code"
                    className="w-full bg-white/5 border border-white/10 rounded-xl px-12 py-3 text-sm text-white placeholder:text-white/20 focus:outline-none focus:border-white/30 transition-colors"
                  />
                </div>
              </div>
            )}
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
                    placeholder="Min 6 characters"
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
