import { ImageResponse } from "next/og";
import { site } from "@/lib/content";

// The preview card shown when the site is shared on LinkedIn, WhatsApp, Slack, etc.
export const alt = `${site.name} — ${site.role}`;
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const PAPER = "#f4f1ea";
const INK = "#15140f";
const ACCENT = "#d9431f";

export default async function Image() {
  // A small "attention map" motif, matching the site's hero figure.
  const cells = Array.from({ length: 36 }, (_, i) => {
    const row = Math.floor(i / 6);
    const col = i % 6;
    return col > row ? 0 : Math.max(0.15, 1 - (row - col) * 0.22);
  });

  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", background: PAPER, padding: 72, color: INK }}>
        <div style={{ display: "flex", flexDirection: "column", justifyContent: "space-between", flex: 1 }}>
          <div style={{ display: "flex", fontSize: 21, letterSpacing: 3, textTransform: "uppercase", color: "#6b665c" }}>
            Sr. AI Researcher · Simplilearn · Bengaluru
          </div>
          <div style={{ display: "flex", flexDirection: "column" }}>
            <div style={{ fontSize: 96, fontWeight: 700, lineHeight: 1 }}>{site.name}</div>
            <div style={{ fontSize: 40, marginTop: 24, color: ACCENT }}>Research → systems that ship.</div>
            <div style={{ fontSize: 25, marginTop: 20, color: "#6b665c" }}>
              Agents · LLMs · RAG · Medical imaging · Quantum attention
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", fontSize: 26 }}>
            <div style={{ width: 14, height: 14, borderRadius: 7, background: ACCENT, marginRight: 14 }} />
            Ask Dumbledore, my AI agent → {site.url.replace("https://", "")}
          </div>
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", width: 6 * 58, alignContent: "center" }}>
          {cells.map((w, i) => (
            <div
              key={i}
              style={{
                width: 50,
                height: 50,
                margin: 4,
                borderRadius: 4,
                background: w ? ACCENT : "transparent",
                opacity: w || 1,
                border: w ? "none" : "2px solid #d9d2c3",
              }}
            />
          ))}
        </div>
      </div>
    ),
    size,
  );
}
