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
import UpdateBanner from "./components/UpdateBanner";
import Loading from "./components/Loading";

function AppContent() {
  const { user, profile, loading } = useAuth();
  const navigate = useNavigate();

  const handleNavigate = (page: string) => {
    navigate(page.startsWith('/') ? page : `/${page}`);
  };

  useEffect(() => {
    console.log('[App] Initializing background data loader...');
    const refreshInBackground = () => {
      dataLoader.loadAll().then(() => {
        console.log('[App] ✓ Background data refreshed');
      }).catch(err => {
        console.warn('[App] Background refresh skipped:', err);
      });
    };
    refreshInBackground();
    dataLoader.startAutoRefresh();
    const resume = () => {
      if (document.visibilityState === 'visible') refreshInBackground();
    };
    document.addEventListener('visibilitychange', resume);
    window.addEventListener('pageshow', resume);
    return () => {
      dataLoader.stopAutoRefresh();
      document.removeEventListener('visibilitychange', resume);
      window.removeEventListener('pageshow', resume);
    };
  }, []);


  return (
    <div className="overflow-x-hidden">
      <AppBackground />
      <UpdateBanner />
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
        <Route path="/admin" element={loading ? <Loading text="Checking account..." size="sm" /> : user && profile?.role === 'admin' ? <AdminPortal onNavigate={handleNavigate} /> : <Navigate to="/" />} />
        <Route path="/team-owner" element={loading ? <Loading text="Checking account..." size="sm" /> : user && profile?.role === 'team_manager' ? <TeamOwnerPortal /> : <Navigate to="/" />} />
        <Route path="/team-portal" element={loading ? <Loading text="Checking account..." size="sm" /> : user && profile?.role === 'team_manager' ? <TeamPortal onNavigate={handleNavigate} /> : <Navigate to="/" />} />
        <Route path="/media-portal" element={loading ? <Loading text="Checking account..." size="sm" /> : user && profile?.role === 'media' ? <MediaPortal onNavigate={handleNavigate} /> : <Navigate to="/" />} />
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
