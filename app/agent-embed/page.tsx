import type { Metadata } from "next";
import { EmbeddedAgent } from "@/components/chat/EmbeddedAgent";

// The chat on its own, for the 3D page's small window (an iframe at /3d; next.config.ts lets only this site frame
// it). Not a page people land on: no header, footer or tracker (components/site/SiteChrome.tsx), not indexed.
export const metadata: Metadata = { title: "Dumbledore", robots: { index: false, follow: false } };

export default function AgentEmbedPage() {
  return <EmbeddedAgent />;
}
