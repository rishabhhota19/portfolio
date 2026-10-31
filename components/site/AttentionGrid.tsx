// "Fig. 1" — an illustrative self-attention map over the hero sentence.
// Values are deterministic (no Math.random) so the page prerenders as fully static.
const TOKENS = ["⟨s⟩", "I", "turn", "new", "AI", "research", "into", "systems", "that", "ship", "."];

function noise(i: number, j: number) {
  const x = Math.sin(i * 12.9898 + j * 78.233) * 43758.5453;
  return x - Math.floor(x);
}

function weight(i: number, j: number) {
  if (j > i) return 0; // causal mask
  const diagonal = Math.exp(-(i - j) / 1.6);
  const sink = j === 0 ? 0.45 : 0; // attention sink on the start token
  const semantic = (i === 9 && j === 7) || (i === 7 && j === 5) || (i === 5 && j === 4) ? 0.75 : 0;
  return Math.min(1, 0.08 + diagonal * 0.7 + sink + semantic + noise(i, j) * 0.18);
}

const CELL = 22;
const GAP = 3;
const LEFT = 64;
const TOP = 64;

export function AttentionGrid() {
  const n = TOKENS.length;
  const size = n * (CELL + GAP);
  return (
    <svg
      viewBox={`0 0 ${LEFT + size + 8} ${TOP + size + 8}`}
      role="img"
      aria-label="Illustrative causal self-attention heatmap over the sentence: I turn new AI research into systems that ship."
      className="h-auto w-full"
    >
      {TOKENS.map((t, k) => (
        <g key={`labels-${k}`} className="fill-[var(--muted)]" style={{ fontFamily: "var(--font-label)", fontSize: 10 }}>
          <text x={LEFT - 8} y={TOP + k * (CELL + GAP) + CELL / 2 + 3.5} textAnchor="end">
            {t}
          </text>
          <text
            transform={`translate(${LEFT + k * (CELL + GAP) + CELL / 2 + 3.5}, ${TOP - 8}) rotate(-60)`}
            textAnchor="start"
          >
            {t}
          </text>
        </g>
      ))}
      {TOKENS.map((_, i) =>
        TOKENS.map((__, j) => {
          const w = weight(i, j);
          return (
            <rect
              key={`${i}-${j}`}
              className="cell"
              style={{ ["--d" as string]: i + j }}
              x={LEFT + j * (CELL + GAP)}
              y={TOP + i * (CELL + GAP)}
              width={CELL}
              height={CELL}
              rx={2}
              fill={w === 0 ? "transparent" : "var(--accent)"}
              fillOpacity={w === 0 ? 0 : Number(w.toFixed(2))}
              stroke="var(--rule)"
              strokeWidth={w === 0 ? 1 : 0}
            />
          );
        }),
      )}
    </svg>
  );
}
