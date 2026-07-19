interface LoadingProps {
  text?: string;
  size?: 'sm' | 'md' | 'lg';
}

export default function Loading({ text = 'LOADING...', size = 'md' }: LoadingProps) {
  const sizeClasses = {
    sm: 'w-12 h-12',
    md: 'w-20 h-20',
    lg: 'w-32 h-32'
  };

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-[#0B0E13]">
      <div className="relative">
        {/* Rotating Logo */}
        <div className={`${sizeClasses[size]} animate-spin`}>
          <img src="/kicklive-icon.png" alt="KickLive" className="w-full h-full object-contain" />
        </div>
        
        {/* Pulsing Glow Effect */}
        <div className="absolute inset-0 bg-brand-green/20 rounded-full blur-xl animate-pulse"></div>
      </div>
      
      {/* Loading Text */}
      <p className="text-brand-green font-black uppercase tracking-[0.3em] mt-6 animate-pulse">
        {text}
      </p>
      
      {/* Dots Animation */}
      <div className="flex gap-2 mt-4">
        <div className="w-2 h-2 bg-brand-green rounded-full animate-bounce" style={{ animationDelay: '0ms' }}></div>
        <div className="w-2 h-2 bg-brand-green rounded-full animate-bounce" style={{ animationDelay: '150ms' }}></div>
        <div className="w-2 h-2 bg-brand-green rounded-full animate-bounce" style={{ animationDelay: '300ms' }}></div>
      </div>
    </div>
  );
}
