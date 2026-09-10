import { assetUrl } from "../lib/app-shell.ts";

/**
 * The `Suspense` fallback for Phase 4's split routes (`src/App.tsx`).
 *
 * It is the boot splash's language, not a spinner: `App.tsx` already shows the mark, the wordmark colour and
 * three bouncing dots while auth resolves, so a route chunk arriving is the same visual event it already
 * handles. `prefers-reduced-motion` is respected the way the rest of the app respects it (Tailwind's
 * `motion-reduce:` variant strips the animation, leaving a static mark).
 *
 * The image is `brand/icon-192.png` — the file the header is already loading — rather than a dedicated
 * spinner graphic, so a route change costs no bytes at all.
 */
export default function RouteFallback() {
  return (
    <div className="relative min-h-[60vh] flex items-center justify-center" role="status" aria-live="polite">
      <div className="text-center">
        <div className="w-16 h-16 mx-auto mb-4 animate-pulse motion-reduce:animate-none">
          <img src={assetUrl("brand/icon-192.png")} alt="" className="w-full h-full object-contain" />
        </div>
        <p className="text-[#39FF14] font-black uppercase tracking-[0.3em] text-xs">Loading</p>
        <div className="flex gap-2 mt-3 justify-center">
          <span className="w-1.5 h-1.5 bg-brand-green rounded-full animate-bounce motion-reduce:animate-none" style={{ animationDelay: "0ms" }} />
          <span className="w-1.5 h-1.5 bg-brand-green rounded-full animate-bounce motion-reduce:animate-none" style={{ animationDelay: "150ms" }} />
          <span className="w-1.5 h-1.5 bg-brand-green rounded-full animate-bounce motion-reduce:animate-none" style={{ animationDelay: "300ms" }} />
        </div>
      </div>
    </div>
  );
}
