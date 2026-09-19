import { HashRouter, Routes, Route, Navigate, useNavigate } from "react-router-dom";
import { Suspense, lazy, useEffect } from "react";
import { AuthProvider, useAuth } from "./contexts/AuthContext";
import { ToastProvider } from "./contexts/ToastContext";
import AppBackground from "./components/AppBackground";
import HomePage from "./pages/HomePage";
import RouteFallback from "./components/RouteFallback";

/**
 * Phase 4 split the route bundle. `HomePage` stays a static import because it is what a fan's first paint
 * renders, and everything else is `lazy()`: before this, `vite build` emitted one 735 KiB app chunk
 * containing the admin portal, the team-owner portal, the media portal, the match-control surfaces and every
 * profile page, and a visitor reading the scores downloaded all of it. A chunk per route is also what makes
 * the *next* visit cheap — the file a returning visitor needs is already in cache, and the one they do not
 * need never loads at all.
 *
 * Two rules, both from the split actually having to help: nothing above the `Suspense` boundary moved
 * (providers and `AppBackground` render immediately, so the shell never blanks), and no route's component is
 * imported statically anywhere else — `import()` a module the entry also pulls in and the bundler merges it
 * back into the entry chunk, which silently undoes the split while still "working".
 */
const MatchesPage = lazy(() => import("./pages/MatchesPage"));
const StandingsPage = lazy(() => import("./pages/StandingsPage"));
const TeamsPage = lazy(() => import("./pages/TeamsPage"));
const PredictionsPage = lazy(() => import("./pages/PredictionsPage"));
const LoginPage = lazy(() => import("./pages/auth/LoginPage"));
const SignupPage = lazy(() => import("./pages/auth/SignupPage"));
const ForgotPasswordPage = lazy(() => import("./pages/auth/ForgotPasswordPage"));
const AdminPortal = lazy(() => import("./pages/portals/AdminPortal"));
// No `FanPortal` here on purpose: `src/pages/portals/FanPortal.tsx` has never been reachable — the static
// import above App's route table imported it, and no `<Route>` ever rendered it. Under `lazy()` an unused
// entry would emit an orphan chunk instead of dead weight inside a shared one, so the import is gone rather
// than deferred. The screen and its data-layer reads stay in the tree (docs/PHASE4_DATA_ARCHITECTURE.md §5);
// wiring a route to it is a product decision, not a build fix.
const TeamPortal = lazy(() => import("./pages/portals/TeamPortal"));
const TeamOwnerPortal = lazy(() => import("./pages/portals/TeamOwnerPortal"));
const MediaPortal = lazy(() => import("./pages/portals/MediaPortal"));
const TeamProfile = lazy(() => import("./pages/TeamProfile"));
const PlayerProfile = lazy(() => import("./pages/PlayerProfile"));
const MatchDetails = lazy(() => import("./pages/MatchDetails"));
const ProfilePage = lazy(() => import("./pages/ProfilePage"));
const NewsPage = lazy(() => import("./pages/NewsPage"));
const MessagesPage = lazy(() => import("./pages/MessagesPage"));
import { initDataLayer } from "./lib/data";
import { log } from "./lib/log";
import { assetUrl } from "./lib/app-shell.ts";

function AppContent() {
  const { user, profile, loading } = useAuth();
  const navigate = useNavigate();

  const handleNavigate = (page: string) => {
    navigate(page.startsWith('/') ? page : `/${page}`);
  };

  useEffect(() => {
    // Phase 4 replaced this effect. It used to call `dataLoader.loadAll()` — six queries for a cache with
    // zero readers (audit finding F-01) — and `startAutoRefresh()`, six more every five minutes per visible
    // tab. `initDataLayer()` starts one ticker that refreshes only what a mounted screen armed, pauses while
    // hidden, and does nothing at all on a page that is not polling. Pages read through `src/lib/data`, so
    // the app-wide warm-up has no job left: the first screen to need a key asks for it, and everyone else
    // gets that answer.
    initDataLayer();
    log.debug('[App] data layer ready');
  }, []);

  if (loading) {
    return (
      <>
        <AppBackground />
        <div className="relative min-h-screen flex items-center justify-center px-6">
          <div className="text-center z-10 w-full max-w-xs">
            <img
              src={assetUrl("brand/wordmark-480.png")}
              alt="KickLive"
              className="w-full max-w-[280px] h-auto mx-auto mb-8 object-contain animate-brand-breathe"
            />
            <div className="loader-track h-1 w-full max-w-[220px] mx-auto" role="status" aria-label="Loading" />
            <p className="mt-4 text-white/50 font-semibold uppercase tracking-[0.3em] text-xs">Loading</p>
          </div>
        </div>
      </>
    );
  }

  return (
    <div className="overflow-x-hidden">
      <AppBackground />
      <Suspense fallback={<RouteFallback />}>
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
        <Route path="/messages" element={user ? <MessagesPage /> : <Navigate to="/login" />} />
        {/*
          Protected Portal Routes — UX only, and deliberately not a security control.
          `profile.role` is a value the browser can overwrite, so these guards only stop honest users
          from landing on a portal they cannot use. The authority is Postgres RLS, which today is the
          *only* thing standing between a caller and privileged writes; Phase 2 moves those writes
          behind Worker endpoints that re-check the role server-side.
        */}
        <Route path="/admin" element={user && profile?.role === 'admin' ? <AdminPortal onNavigate={handleNavigate} /> : <Navigate to="/" />} />
        <Route path="/team-owner" element={user && profile?.role === 'team_manager' ? <TeamOwnerPortal /> : <Navigate to="/" />} />
        <Route path="/team-portal" element={user && profile?.role === 'team_manager' ? <TeamPortal onNavigate={handleNavigate} /> : <Navigate to="/" />} />
        <Route path="/media-portal" element={user && profile?.role === 'media' ? <MediaPortal onNavigate={handleNavigate} /> : <Navigate to="/" />} />
        {/* Catch all */}
        <Route path="*" element={<HomePage />} />
      </Routes>
      </Suspense>
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
