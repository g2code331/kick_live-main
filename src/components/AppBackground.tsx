export default function AppBackground() {
  return (
    <div className="fixed inset-0 -z-10 pointer-events-none">
      {/* Subtle Gradient Background */}
      <div className="absolute inset-0 bg-gradient-to-br from-[#0B0E13] via-[#0B0E13] to-[#0a0d12]"></div>
      
      {/* Very Subtle Logo Pattern - Only visible on close inspection */}
      <div 
        className="absolute inset-0 opacity-[0.015]"
        style={{
          backgroundImage: `url('/kicklive-icon.png')`,
          backgroundRepeat: 'repeat',
          backgroundSize: '300px 300px'
        }}
      ></div>
      
      {/* Subtle Vignette Effect */}
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,transparent_50%,rgba(11,14,19,0.4)_100%)]"></div>
    </div>
  );
}
