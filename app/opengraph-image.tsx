import { ImageResponse } from "next/og";
import { site } from "@/lib/content";

// The preview card shown when the site is shared on LinkedIn, WhatsApp, Slack, etc.
export const alt = `${site.name} — ${site.role}`;
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const PAPER = "#0c0c0e";
const INK = "#f3efe6";
const ACCENT = "#cdae72";

export default async function Image() {
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", background: PAPER, padding: 72, color: INK }}>
        <div style={{ display: "flex", flexDirection: "column", justifyContent: "space-between", flex: 1 }}>
          <div style={{ display: "flex", fontSize: 21, letterSpacing: 3, textTransform: "uppercase", color: "#a8a295" }}>
            Sr. AI Researcher · Simplilearn · Bengaluru
          </div>
          <div style={{ display: "flex", flexDirection: "column" }}>
            <div style={{ fontSize: 96, fontWeight: 700, lineHeight: 1 }}>{site.name}</div>
            <div style={{ fontSize: 40, marginTop: 24, color: ACCENT }}>Research → systems that ship.</div>
            <div style={{ fontSize: 25, marginTop: 20, color: "#a8a295" }}>
              Agents · LLMs · RAG · Medical imaging · Quantum attention
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", fontSize: 26 }}>
            <div style={{ width: 14, height: 14, borderRadius: 7, background: ACCENT, marginRight: 14 }} />
            Ask Dumbledore, my AI agent → {site.url.replace("https://", "")}
          </div>
        </div>
      </div>
    ),
    size,
  );
}
