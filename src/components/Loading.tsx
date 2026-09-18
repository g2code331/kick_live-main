import { assetUrl } from "../lib/app-shell.ts";

interface LoadingProps {
  text?: string;
  size?: 'sm' | 'md' | 'lg';
}

export default function Loading({ text = 'LOADING', size = 'md' }: LoadingProps) {
  const markClasses = {
    sm: 'max-w-[160px]',
    md: 'max-w-[220px]',
    lg: 'max-w-[300px]',
  };

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-[#0B0E13] px-6">
      <div className="w-full max-w-xs text-center">
        {/* Static wordmark — no spin, no glow */}
        <img
          src={assetUrl("brand/wordmark-480.png")}
          alt="KickLive"
          className={`${markClasses[size]} w-full h-auto mx-auto mb-8 object-contain animate-brand-breathe`}
        />

        {/* Modern indeterminate progress bar */}
        <div className="loader-track h-1 w-full max-w-[220px] mx-auto" role="status" aria-label={text} />

        <p className="mt-4 text-white/50 font-semibold uppercase tracking-[0.3em] text-xs">
          {text}
        </p>
      </div>
    </div>
  );
}
