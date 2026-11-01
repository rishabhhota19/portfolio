import { addAction } from "@/lib/visit";

// Umami custom events (page views are tracked automatically by the script in app/layout.tsx).
// Never send chat text or personal details — only what happened and where.
// Each event is also added to this visit's actions (the Sessions sheet).
type Umami = { track: (event: string, data?: Record<string, string | number>) => void };

export function track(event: string, data?: Record<string, string | number>) {
  (window as Window & { umami?: Umami }).umami?.track(event, data);
  addAction(event);
}
