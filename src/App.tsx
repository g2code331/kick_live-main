import { HashRouter, Routes, Route, Navigate, useNavigate } from "react-router-dom";
import { useEffect } from "react";
import { AuthProvider, useAuth } from "./contexts/AuthContext";
import { ToastProvider } from "./contexts/ToastContext";
import AppBackground from "./components/AppBackground";
import HomePage from "./pages/HomePage";
import MatchesPage from "./pages/MatchesPage";
import StandingsPage from "./pages/StandingsPage";
import TeamsPage from "./pages/TeamsPage";
import PredictionsPage from "./pages/PredictionsPage";
import LoginPage from "./pages/auth/LoginPage";
import SignupPage from "./pages/auth/SignupPage";
import ForgotPasswordPage from "./pages/auth/ForgotPasswordPage";
import AdminPortal from "./pages/portals/AdminPortal";
import FanPortal from "./pages/portals/FanPortal";
import TeamPortal from "./pages/portals/TeamPortal";
import TeamOwnerPortal from "./pages/portals/TeamOwnerPortal";
import MediaPortal from "./pages/portals/MediaPortal";
import TeamProfile from "./pages/TeamProfile";
import PlayerProfile from "./pages/PlayerProfile";
import MatchDetails from "./pages/MatchDetails";
import ProfilePage from "./pages/ProfilePage";
import NewsPage from "./pages/NewsPage";
import { dataLoader } from "./lib/DataLoader";

function AppContent() {
  const { user, profile, loading } = useAuth();
  const navigate = useNavigate();

  const handleNavigate = (page: string) => {
    navigate(page.startsWith('/') ? page : `/${page}`);
  };

  useEffect(() => {
    console.log('[App] Initializing background data loader...');
    dataLoader.loadAll().then(() => {
      console.log('[App] ✓ Initial data loaded');
    }).catch(err => {
      console.error('[App] Initial data load failed:', err);
    });
    dataLoader.startAutoRefresh();
    return () => { dataLoader.stopAutoRefresh(); };
  }, []);

  if (loading) {
    return (
      <>
        <AppBackground />
        <div className="relative min-h-screen flex items-center justify-center">
          <div className="text-center z-10">
            <div className="w-32 h-32 mx-auto mb-6 animate-spin">
              <img src="/kicklive-icon.png" alt="KickLive" className="w-full h-full object-contain" />
            </div>
            <p className="text-[#39FF14] font-black uppercase tracking-[0.3em] animate-pulse">Loading...</p>
            <div className="flex gap-2 mt-4 justify-center">
              <div className="w-2 h-2 bg-brand-green rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
              <div className="w-2 h-2 bg-brand-green rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
              <div className="w-2 h-2 bg-brand-green rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
            </div>
          </div>
        </div>
      </>
    );
  }

  return (
    <div className="overflow-x-hidden">
      <AppBackground />
      <Routes>
        {/* Public Routes */}
        <Route path="/" element={<HomePage />} />
        <Route path="/home" element={<HomePage />} />
        <Route path="/matches" element={<MatchesPage />} />
        <Route path="/match/:matchId" element={<MatchDetails />} />
        <Route path="/tables" element={<StandingsPage />} />
        <Route path="/teams" element={<TeamsPage />} />
        <Route path="/team/:teamId" element={<TeamProfile />} />
        <Route path="/news" element={<NewsPage />} />
        <Route path="/player/:playerId" element={<PlayerProfile />} />
        {/* Predictions replaces Draw */}
        <Route path="/predictions" element={<PredictionsPage />} />
        <Route path="/draw" element={<PredictionsPage />} />
        {/* Auth */}
        <Route path="/login" element={<LoginPage onNavigate={handleNavigate} />} />
        <Route path="/signup" element={<SignupPage onNavigate={handleNavigate} />} />
        <Route path="/forgot-password" element={<ForgotPasswordPage onNavigate={handleNavigate} />} />
        {/* User Profile */}
        <Route path="/profile" element={<ProfilePage />} />
        {/* Protected Portal Routes */}
        <Route path="/admin" element={user && profile?.role === 'admin' ? <AdminPortal onNavigate={handleNavigate} /> : <Navigate to="/" />} />
        <Route path="/team-owner" element={user && profile?.role === 'team_manager' ? <TeamOwnerPortal /> : <Navigate to="/" />} />
        <Route path="/team-portal" element={user && profile?.role === 'team_manager' ? <TeamPortal onNavigate={handleNavigate} /> : <Navigate to="/" />} />
        <Route path="/media-portal" element={user && profile?.role === 'media' ? <MediaPortal onNavigate={handleNavigate} /> : <Navigate to="/" />} />
        {/* Catch all */}
        <Route path="*" element={<HomePage />} />
      </Routes>
    </div>
  );
}

export default function App() {
  return (
    <HashRouter>
      <AuthProvider>
        <ToastProvider>
          <AppContent />
        </ToastProvider>
      </AuthProvider>
    </HashRouter>
  );
}
