import { Server } from "lucide-react";
import type { ForgeKind } from "../lib/types";

/**
 * Small generic marks for each provider. These are simple original glyphs,
 * not the providers' trademarked logos, so we never ship their artwork.
 */
export function ForgeIcon({ kind, size = 14 }: { kind: ForgeKind | null; size?: number }) {
  if (!kind) return <Server size={size} />;
  const color = kind === "github" ? "currentColor" : kind === "gitlab" ? "#fc8d4e" : "#7ccf6b";
  const letter = kind === "github" ? "GH" : kind === "gitlab" ? "GL" : "GT";
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-label={kind} className="forge-icon">
      <rect x="1" y="1" width="14" height="14" rx="4" fill="none" stroke={color} strokeWidth="1.6" />
      <text x="8" y="10.8" textAnchor="middle" fontSize="6.6" fontWeight="700" fill={color} fontFamily="ui-sans-serif, system-ui">
        {letter}
      </text>
    </svg>
  );
}

export const FORGE_LABEL: Record<ForgeKind, string> = {
  github: "GitHub",
  gitlab: "GitLab",
  gitea: "Gitea / Forgejo",
};
