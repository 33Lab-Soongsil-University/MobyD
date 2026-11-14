/**
 * MobyD's mark (original artwork): an abstract white whale — a flat, faceless
 * sperm-whale silhouette whose tail becomes a branch in a commit graph
 * (a branch point and two branch tips).
 */
const BODY =
  "M21 50 C30 46.5 42 38.5 58 35.2 C70 32.8 82 32.4 89 33.6 C94.2 34.6 96.4 38.8 96 44.4 L95.6 48.4 C95 53.6 91.8 56.2 85.8 57.2 C75 59 61 60 49 59.2 C37 58.4 28 54.6 21 50 Z";
const TAIL = "M20 50 C14 50 10.5 45 8.5 37.5 M20 50 C14 50 10.5 55 8.5 62.5";
const NODES: [number, number][] = [
  [20, 50],
  [8.5, 37.5],
  [8.5, 62.5],
];

function Whale({ nodeStroke = 2.5, tailStroke = 4 }: { nodeStroke?: number; tailStroke?: number }) {
  return (
    <g transform="rotate(-9 52 49)">
      <path d={BODY} fill="var(--whale-body)" />
      <path d={TAIL} fill="none" stroke="var(--whale-body)" strokeWidth={tailStroke} strokeLinecap="round" />
      <g fill="var(--bg)" stroke="var(--whale-node)" strokeWidth={nodeStroke}>
        {NODES.map(([x, y]) => (
          <circle key={`${x}-${y}`} cx={x} cy={y} r="3.4" />
        ))}
      </g>
    </g>
  );
}

/** Small mark for the title bar. */
export function WhaleMark({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={(size * 42) / 100} viewBox="0 29 100 42" aria-hidden="true" className="whale-mark">
      <Whale nodeStroke={3} tailStroke={5} />
    </svg>
  );
}

/** Larger version for the repository manager. */
export function WhaleHero({ size = 180 }: { size?: number }) {
  return (
    <svg width={size} height={(size * 48) / 104} viewBox="0 26 104 48" aria-hidden="true" className="hero-mark">
      <g className="hero-whale">
        <Whale />
      </g>
    </svg>
  );
}
