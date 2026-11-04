"use client";

import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

/** The site's header, footer, chat launcher and visit tracker: everywhere but /agent-embed, which is only the chat,
 * shown inside the 3D page (app/agent-embed/page.tsx). */
export function SiteChrome({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  if (pathname.startsWith("/agent-embed")) return null;
  return children;
}
