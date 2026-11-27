import type { FC, SVGProps } from 'react';

// The library renders these from lucide-react, which is not a dependency here.
// `.aui-button svg` already fixes the size, so these only carry the path.
const svg = (props: SVGProps<SVGSVGElement>) => ({
  viewBox: '0 0 24 24',
  width: 16,
  height: 16,
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
  ...props,
});

export const ArrowDownIcon: FC<SVGProps<SVGSVGElement>> = (props) => (
  <svg {...svg(props)}>
    <path d="M12 5v14" />
    <path d="m19 12-7 7-7-7" />
  </svg>
);

export const SendIcon: FC<SVGProps<SVGSVGElement>> = (props) => (
  <svg {...svg(props)}>
    <path d="M5 12h14" />
    <path d="m12 5 7 7-7 7" />
  </svg>
);

export const StopIcon: FC<SVGProps<SVGSVGElement>> = (props) => (
  <svg {...svg(props)}>
    <circle cx="12" cy="12" r="9" />
    <rect x="9" y="9" width="6" height="6" rx="1" fill="currentColor" stroke="none" />
  </svg>
);

export const CopyIcon: FC<SVGProps<SVGSVGElement>> = (props) => (
  <svg {...svg(props)}>
    <rect x="9" y="9" width="11" height="11" rx="2" />
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
  </svg>
);

export const CheckIcon: FC<SVGProps<SVGSVGElement>> = (props) => (
  <svg {...svg(props)}>
    <path d="M20 6 9 17l-5-5" />
  </svg>
);

export const PaperclipIcon: FC<SVGProps<SVGSVGElement>> = (props) => (
  <svg {...svg(props)}>
    <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" />
  </svg>
);

export const CloseIcon: FC<SVGProps<SVGSVGElement>> = (props) => (
  <svg {...svg(props)}>
    <path d="M18 6 6 18" />
    <path d="m6 6 12 12" />
  </svg>
);
