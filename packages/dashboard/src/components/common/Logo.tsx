/**
 * Canton Streams Logo — SVG mark + wordmark.
 *
 * The mark represents continuous payment streaming:
 * three flowing lines that converge into a single stream,
 * echoing the concept of tokenized value flowing over time.
 */

interface LogoProps {
  className?: string;
  showText?: boolean;
  size?: 'sm' | 'md' | 'lg';
}

const sizes = {
  sm: { mark: 24, text: 'text-sm' },
  md: { mark: 32, text: 'text-base' },
  lg: { mark: 40, text: 'text-lg' },
};

export function Logo({ className = '', showText = true, size = 'md' }: LogoProps) {
  const { mark, text } = sizes[size];

  return (
    <div className={`flex items-center gap-2.5 ${className}`}>
      <LogoMark size={mark} />
      {showText && (
        <div className="flex flex-col leading-tight">
          <span className={`font-semibold tracking-tight ${text}`}>
            Canton <span className="font-bold">Streams</span>
          </span>
        </div>
      )}
    </div>
  );
}

function LogoMark({ size }: { size: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 40 40"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-label="Canton Streams logo"
    >
      {/* Background circle with subtle gradient */}
      <defs>
        <linearGradient id="logo-bg" x1="0" y1="0" x2="40" y2="40" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#6366f1" />
          <stop offset="100%" stopColor="#4f46e5" />
        </linearGradient>
        <linearGradient id="stream-glow" x1="8" y1="20" x2="32" y2="20" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#e0e7ff" stopOpacity="0.6" />
          <stop offset="50%" stopColor="#ffffff" stopOpacity="1" />
          <stop offset="100%" stopColor="#c7d2fe" stopOpacity="0.6" />
        </linearGradient>
      </defs>
      <rect width="40" height="40" rx="10" fill="url(#logo-bg)" />
      {/* Three flowing stream lines — converging to represent continuous settlement */}
      <path
        d="M10 13 C16 13, 18 17, 22 18 C26 19, 28 16, 32 15"
        stroke="url(#stream-glow)"
        strokeWidth="2.2"
        strokeLinecap="round"
        fill="none"
        opacity="0.7"
      />
      <path
        d="M10 20 C15 20, 18 22, 22 21 C26 20, 28 20, 32 20"
        stroke="#ffffff"
        strokeWidth="2.8"
        strokeLinecap="round"
        fill="none"
      />
      <path
        d="M10 27 C16 27, 18 23, 22 22 C26 21, 28 24, 32 25"
        stroke="url(#stream-glow)"
        strokeWidth="2.2"
        strokeLinecap="round"
        fill="none"
        opacity="0.7"
      />
      {/* Small accent dot — active stream indicator */}
      <circle cx="32" cy="20" r="2.5" fill="#a5b4fc" opacity="0.9" />
    </svg>
  );
}

export { LogoMark };
