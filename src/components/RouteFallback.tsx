import { assetUrl } from "../lib/app-shell.ts";

/**
 * The `Suspense` fallback for Phase 4's split routes (`src/App.tsx`).
 *
 * It speaks the boot splash's language: the static wordmark plus a thin indeterminate progress bar —
 * no spinning logo and no glow. `App.tsx` shows the same mark while auth resolves, so a route chunk
 * arriving is the same visual event. `prefers-reduced-motion` is honoured in `index.css` (the bar
 * freezes and the breathe stops), leaving a legible static mark.
 *
 * The image is `brand/wordmark-480.png` — the file the splash is already loading — rather than a
 * dedicated spinner graphic, so a route change costs no extra bytes.
 */
export default function RouteFallback() {
  return (
    <div className="relative min-h-[60vh] flex items-center justify-center px-6" role="status" aria-live="polite">
      <div className="text-center w-full max-w-[220px]">
        <img
          src={assetUrl("brand/wordmark-480.png")}
          alt=""
          className="w-full max-w-[180px] h-auto mx-auto mb-5 object-contain animate-brand-breathe"
        />
        <div className="loader-track h-1 w-full mx-auto" aria-label="Loading" />
        <p className="mt-3 text-white/45 font-semibold uppercase tracking-[0.3em] text-[11px]">Loading</p>
      </div>
    </div>
  );
}
