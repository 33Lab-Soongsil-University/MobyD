/**
 * MobyD's mark (original artwork): a sperm whale seen from far below, hanging
 * upright in the deep — the blunt head, two small fins, the flukes — under
 * rings of light from the surface. Commits ride the rings.
 */
const WHALE =
  "M50 3 C60 3 66.5 7 67 16 C67.8 27 69.4 37 69 47 C74.5 51 80 58 82 67 C75.5 65 70.5 62 67.6 58.5 C65 78 58.5 100 53.4 118 C59 123 73 127 85 139 C72 134.5 60 133 50 136 C40 133 28 134.5 15 139 C27 127 41 123 46.6 118 C41.5 100 35 78 32.4 58.5 C29.5 62 24.5 65 18 67 C20 58 25.5 51 31 47 C30.6 37 32.2 27 33 16 C33.5 7 40 3 50 3 Z";

/** Small glyph for the title bar and empty states: the whale alone, swimming right. */
export function WhaleMark({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={(size * 80) / 150} viewBox="0 0 150 80" aria-hidden="true" className="whale-mark">
      <g transform="translate(75 40) rotate(90) translate(-50 -71)">
        <path d={WHALE} fill="var(--whale-body)" />
      </g>
    </svg>
  );
}

/** The full mark for the repository manager: the whale rising under the rings, its tail fading into the deep. */
export function WhaleHero({ size = 96 }: { size?: number }) {
  return (
    <svg width={size} height={(size * 164) / 120} viewBox="0 0 120 164" aria-hidden="true" className="hero-mark">
      <defs>
        <linearGradient id="whale-fade" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" style={{ stopColor: "var(--whale-body)" }} />
          <stop offset="0.6" style={{ stopColor: "var(--whale-body)", stopOpacity: 0.92 }} />
          <stop offset="1" style={{ stopColor: "var(--whale-body)", stopOpacity: 0.18 }} />
        </linearGradient>
      </defs>
      <g fill="none" stroke="var(--whale-node)">
        <circle cx="60" cy="30" r="24" strokeWidth={1.4} opacity={0.7} />
        <circle cx="60" cy="30" r="40" strokeWidth={1} opacity={0.3} />
      </g>
      <g transform="translate(10 18)">
        <g className="hero-whale">
          <path d={WHALE} fill="url(#whale-fade)" />
        </g>
      </g>
      <g fill="var(--panel, var(--bg))" stroke="var(--whale-node)" strokeWidth={1.4}>
        <circle cx="78.9" cy="15.2" r="2.6" />
        <circle cx="22.4" cy="43.7" r="2.6" />
      </g>
    </svg>
  );
}
