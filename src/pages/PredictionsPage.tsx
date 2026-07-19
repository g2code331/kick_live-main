import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Lock, TrendingUp, Zap, Trophy, Star } from 'lucide-react';
import Header from '../components/Header';

export default function PredictionsPage() {
  const navigate = useNavigate();

  return (
    <div className="relative min-h-screen">
      <Header />
      <div className="container mx-auto px-4 py-12 relative z-10 max-w-3xl">
        {/* Back */}
        <button
          onClick={() => navigate(-1)}
          className="flex items-center gap-2 text-white/40 hover:text-white transition-colors mb-8 font-bold text-sm uppercase tracking-widest"
        >
          <ArrowLeft size={18} /> Back
        </button>

        {/* Hero */}
        <div className="text-center mb-12">
          <span className="inline-block bg-brand-green/20 text-brand-green px-4 py-1.5 rounded-full text-[10px] font-black uppercase tracking-[0.25em] border border-brand-green/30 mb-4">
            Coming Soon
          </span>
          <h1 className="text-5xl md:text-7xl font-black italic uppercase tracking-tighter leading-none mb-4">
            Predictions &amp; <span className="text-brand-green">Bets</span>
          </h1>
          <p className="text-white/50 text-base max-w-md mx-auto">
            Place match predictions, compete with friends and climb the leaderboard. Launching very soon.
          </p>
        </div>

        {/* Lock card */}
        <div className="glass rounded-[3rem] p-12 border border-white/10 text-center mb-8 relative overflow-hidden">
          {/* bg glow */}
          <div className="absolute inset-0 bg-brand-green/5 rounded-[3rem]"></div>
          <div className="relative z-10">
            <div className="w-24 h-24 mx-auto mb-6 rounded-[2rem] bg-white/5 border border-white/10 flex items-center justify-center">
              <Lock size={40} className="text-white/20" />
            </div>
            <h2 className="text-2xl font-black italic uppercase mb-2">Feature Locked</h2>
            <p className="text-white/40 text-sm">Our predictions &amp; betting engine is in development.<br />Stay tuned for the launch announcement.</p>
          </div>
        </div>

        {/* Feature preview cards */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          {[
            { icon: <TrendingUp size={28} className="text-brand-green" />, title: 'Match Predictions', desc: 'Predict match outcomes before kick-off' },
            { icon: <Trophy size={28} className="text-yellow-400" />, title: 'Leaderboards', desc: 'Compete for the top spot every week' },
            { icon: <Zap size={28} className="text-brand-blue" />, title: 'Live Bets', desc: 'Place in-play bets on live matches' },
          ].map((f, i) => (
            <div key={i} className="glass rounded-[2rem] p-6 border border-white/5 text-center opacity-60">
              <div className="flex justify-center mb-3">{f.icon}</div>
              <h3 className="font-black uppercase text-sm mb-1">{f.title}</h3>
              <p className="text-white/40 text-xs">{f.desc}</p>
            </div>
          ))}
        </div>

        {/* Notify me */}
        <div className="mt-8 glass rounded-[2rem] p-6 border border-white/10 flex flex-col sm:flex-row items-center gap-4">
          <Star size={20} className="text-brand-green shrink-0" />
          <p className="text-white/60 text-sm flex-1">Get notified when Predictions &amp; Bets goes live — just make sure your profile has a valid email.</p>
          <button
            onClick={() => navigate('/profile')}
            className="px-6 py-2.5 rounded-xl gradient-green text-black font-black text-xs uppercase tracking-widest whitespace-nowrap hover:scale-105 transition-transform"
          >
            My Profile
          </button>
        </div>
      </div>
    </div>
  );
}
