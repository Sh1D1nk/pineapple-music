import type { JSX, SVGProps } from 'react'

export type IconName =
  | 'search'
  | 'clock'
  | 'mic'
  | 'disc'
  | 'music'
  | 'gear'
  | 'folderPlus'
  | 'chevronDown'
  | 'chevronRight'
  | 'play'
  | 'pause'
  | 'prev'
  | 'next'
  | 'shuffle'
  | 'repeat'
  | 'repeatOne'
  | 'volumeLow'
  | 'volumeHigh'
  | 'lyrics'
  | 'queue'
  | 'more'
  | 'expand'
  | 'album'
  | 'close'
  | 'trash'
  | 'check'
  | 'info'
  | 'sparkles'
  | 'waveform'
  | 'external'
  | 'plus'
  | 'sortAsc'
  | 'sortDesc'
  | 'grip'

interface Props extends Omit<SVGProps<SVGSVGElement>, 'name'> {
  name: IconName
  size?: number
}

const stroke = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.6,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const
}

const solid = { fill: 'currentColor' }

const paths: Record<IconName, JSX.Element> = {
  search: (
    <g {...stroke}>
      <circle cx="10.8" cy="10.8" r="6.1" />
      <path d="M15.4 15.4 20 20" />
    </g>
  ),
  clock: (
    <g {...stroke}>
      <circle cx="12" cy="12" r="8.2" />
      <path d="M12 7.4V12l3.1 1.9" />
    </g>
  ),
  mic: (
    <g {...stroke}>
      <rect x="9.2" y="3.2" width="5.6" height="10.4" rx="2.8" />
      <path d="M5.8 11.4a6.2 6.2 0 0 0 12.4 0M12 17.6V20.4M9.2 20.4h5.6" />
    </g>
  ),
  disc: (
    <g {...stroke}>
      <circle cx="12" cy="12" r="8.4" />
      <circle cx="12" cy="12" r="2.3" />
    </g>
  ),
  music: (
    <g {...stroke}>
      <path d="M9.4 17.6V6.2l9-2v11.2" />
      <circle cx="6.9" cy="18" r="2.5" />
      <circle cx="15.9" cy="16" r="2.5" />
    </g>
  ),
  gear: (
    <g {...stroke}>
      <circle cx="12" cy="12" r="3.1" />
      <path d="M12 3.4v2.2M12 18.4v2.2M4.9 7.9l1.9 1.1M17.2 15l1.9 1.1M4.9 16.1l1.9-1.1M17.2 9l1.9-1.1" />
    </g>
  ),
  folderPlus: (
    <g {...stroke}>
      <path d="M3.6 7.2c0-.9.7-1.6 1.6-1.6h3.6l1.8 2h8.2c.9 0 1.6.7 1.6 1.6v7.6c0 .9-.7 1.6-1.6 1.6H5.2c-.9 0-1.6-.7-1.6-1.6Z" />
      <path d="M12 11.4v4.8M9.6 13.8h4.8" />
    </g>
  ),
  chevronDown: (
    <g {...stroke}>
      <path d="m6.6 9.8 5.4 5 5.4-5" />
    </g>
  ),
  chevronRight: (
    <g {...stroke}>
      <path d="m9.6 6.4 5.2 5.6-5.2 5.6" />
    </g>
  ),
  play: <path {...solid} d="M8.1 5.3a1.3 1.3 0 0 1 1.97-1.1l9.4 6.2a1.33 1.33 0 0 1 0 2.23l-9.4 6.2A1.3 1.3 0 0 1 8.1 17.7Z" />,
  pause: (
    <g {...solid}>
      <rect x="6.6" y="4.6" width="3.7" height="14.8" rx="1.5" />
      <rect x="13.7" y="4.6" width="3.7" height="14.8" rx="1.5" />
    </g>
  ),
  prev: (
    <g {...solid}>
      <rect x="4.2" y="5.1" width="2.5" height="13.8" rx="1.25" />
      <path d="M19.4 6.5v11a1.2 1.2 0 0 1-1.84 1.02l-8.1-5.4a1.2 1.2 0 0 1 0-2.02l8.1-5.6a1.2 1.2 0 0 1 1.84 1Z" />
    </g>
  ),
  next: (
    <g {...solid}>
      <rect x="17.3" y="5.1" width="2.5" height="13.8" rx="1.25" />
      <path d="M4.6 6.5v11a1.2 1.2 0 0 0 1.84 1.02l8.1-5.4a1.2 1.2 0 0 0 0-2.02L6.44 5.5a1.2 1.2 0 0 0-1.84 1Z" />
    </g>
  ),
  shuffle: (
    <g {...stroke}>
      <path d="M3.6 6.6h2.9c1.2 0 2.3.6 3 1.6l4.2 6.1c.7 1 1.8 1.6 3 1.6h2.7" />
      <path d="M3.6 17.4h2.9c1.2 0 2.3-.6 3-1.6l.9-1.3M14 9.2l.7-1c.7-1 1.8-1.6 3-1.6h2.7" />
      <path d="m17.6 4.4 2.4 2.2-2.4 2.2M17.6 14l2.4 2.2-2.4 2.2" />
    </g>
  ),
  repeat: (
    <g {...stroke}>
      <path d="M6.6 7.2h10.8a2.2 2.2 0 0 1 2.2 2.2v2.4" />
      <path d="m8.9 4.7-2.5 2.5 2.5 2.5" />
      <path d="M17.4 16.8H6.6a2.2 2.2 0 0 1-2.2-2.2v-2.4" />
      <path d="m15.1 19.3 2.5-2.5-2.5-2.5" />
    </g>
  ),
  repeatOne: (
    <g {...stroke}>
      <path d="M6.6 7.2h10.8a2.2 2.2 0 0 1 2.2 2.2v2.4" />
      <path d="m8.9 4.7-2.5 2.5 2.5 2.5" />
      <path d="M17.4 16.8H6.6a2.2 2.2 0 0 1-2.2-2.2v-2.4" />
      <path d="m15.1 19.3 2.5-2.5-2.5-2.5" />
      <path d="M11 10.2h1.2v3.8" strokeWidth={1.4} />
    </g>
  ),
  volumeLow: (
    <g {...stroke}>
      <path d="M4 9.4h3L11 6v12l-4-3.4H4Z" />
      <path d="M14.2 9.6a3.4 3.4 0 0 1 0 4.8" />
    </g>
  ),
  volumeHigh: (
    <g {...stroke}>
      <path d="M3.4 9.4h3L10.4 6v12l-4-3.4h-3Z" />
      <path d="M13.6 9.6a3.4 3.4 0 0 1 0 4.8M16.2 7.2a7 7 0 0 1 0 9.6" />
    </g>
  ),
  lyrics: (
    <g {...stroke}>
      <path d="M4.4 7.2c0-1.1.9-2 2-2h11.2c1.1 0 2 .9 2 2v7.2c0 1.1-.9 2-2 2h-6.1L7 20v-3.6H6.4c-1.1 0-2-.9-2-2Z" />
      <path d="M9.6 9.6h1.4v3M15 9.6h-1.8M15 9.6v3.4" strokeWidth={1.3} />
    </g>
  ),
  queue: (
    <g {...stroke}>
      <path d="M4.4 7.2h10.8M4.4 12h10.8M4.4 16.8h6.6" />
      <circle cx="18.2" cy="16.6" r="1.5" />
    </g>
  ),
  more: (
    <g {...solid}>
      <circle cx="5.6" cy="12" r="1.55" />
      <circle cx="12" cy="12" r="1.55" />
      <circle cx="18.4" cy="12" r="1.55" />
    </g>
  ),
  expand: (
    <g {...stroke}>
      <path d="M9.2 4.8 12 1.9l2.8 2.9" />
      <path d="M12 1.9v6.2" />
      <rect x="3.8" y="10.2" width="16.4" height="10" rx="2.2" />
    </g>
  ),
  album: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <circle cx="12" cy="12" r="2.2" />
    </>
  ),
  close: (
    <g {...stroke}>
      <path d="m6.4 6.4 11.2 11.2M17.6 6.4 6.4 17.6" />
    </g>
  ),
  trash: (
    <g {...stroke}>
      <path d="M5.2 7.4h13.6M9.6 7.4V5.6c0-.7.6-1.2 1.2-1.2h2.4c.7 0 1.2.5 1.2 1.2v1.8" />
      <path d="M6.9 7.4l.8 11c0 .7.6 1.2 1.3 1.2h6c.7 0 1.3-.5 1.3-1.2l.8-11" />
      <path d="M10.4 10.6v5.6M13.6 10.6v5.6" />
    </g>
  ),
  check: (
    <g {...stroke}>
      <path d="m5.4 12.6 4.3 4.2 8.9-9.6" />
    </g>
  ),
  info: (
    <g {...stroke}>
      <circle cx="12" cy="12" r="8.3" />
      <path d="M12 11v5.2M12 8.1v.1" />
    </g>
  ),
  sparkles: (
    <g {...stroke}>
      <path d="M12 3.4l1.7 4.4 4.4 1.7-4.4 1.7L12 15.6l-1.7-4.4L5.9 9.5l4.4-1.7Z" />
      <path d="M18.4 15.2l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8Z" strokeWidth={1.3} />
    </g>
  ),
  waveform: (
    <g {...stroke}>
      <path d="M4 10.4v3.2M7.4 7.6v8.8M10.8 5.2v13.6M14.2 8.6v6.8M17.6 10.8v2.4M21 9.6v4.8" />
    </g>
  ),
  external: (
    <g {...stroke}>
      <path d="M13.4 4.6h6v6M19.4 4.6 11 13" />
      <path d="M17.6 14v4.4c0 .9-.7 1.6-1.6 1.6H5.6c-.9 0-1.6-.7-1.6-1.6V8c0-.9.7-1.6 1.6-1.6H10" />
    </g>
  ),
  plus: (
    <g {...stroke}>
      <path d="M12 5.4v13.2M5.4 12h13.2" />
    </g>
  ),
  sortAsc: (
    <g {...stroke}>
      <path d="M12 18.6V5.4M7.2 10.2 12 5.4l4.8 4.8" />
    </g>
  ),
  sortDesc: (
    <g {...stroke}>
      <path d="M12 5.4v13.2M7.2 13.8 12 18.6l4.8-4.8" />
    </g>
  ),
  grip: (
    <g {...solid}>
      <circle cx="9" cy="7" r="1.4" />
      <circle cx="15" cy="7" r="1.4" />
      <circle cx="9" cy="12" r="1.4" />
      <circle cx="15" cy="12" r="1.4" />
      <circle cx="9" cy="17" r="1.4" />
      <circle cx="15" cy="17" r="1.4" />
    </g>
  )
}

export function Icon({ name, size = 20, ...rest }: Props): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {paths[name]}
    </svg>
  )
}
