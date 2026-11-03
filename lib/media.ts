// The site's heavy media (video loops, 3D models, large images) is served by Cloudflare (cloudflare/media/): free,
// unlimited bandwidth, so it never counts against Vercel's 100 GB a month. The same files sit in public/media/, which
// Vercel serves too: if Cloudflare can't deliver a file, the element switches to that copy (Vercel bandwidth is used
// only then). Without NEXT_PUBLIC_MEDIA_BASE everything loads from Vercel.
import type { SyntheticEvent } from "react";

export const MEDIA_BASE = (process.env.NEXT_PUBLIC_MEDIA_BASE ?? "").replace(/\/+$/, "");

/** The Vercel copy of a file in public/media/. */
export const fallbackUrl = (path: string) => `/media/${path}`;

/** Where to load a file in public/media/ from, e.g. mediaUrl("loops/hero.3f2a91c0.webm"). */
export const mediaUrl = (path: string) => (MEDIA_BASE ? `${MEDIA_BASE}/${path}` : fallbackUrl(path));

/** onError for an <img>, <video> or <source> whose src is mediaUrl(path): switches it to the Vercel copy, once. */
export function onMediaError(path: string) {
  return (e: SyntheticEvent<HTMLImageElement | HTMLVideoElement | HTMLSourceElement>) => {
    const el = e.currentTarget;
    if (el.dataset.fallback) return;
    el.dataset.fallback = "1";
    el.src = fallbackUrl(path);
    if (el instanceof HTMLSourceElement) (el.parentElement as HTMLVideoElement | null)?.load(); // a new <source> needs load()
  };
}

/** fetch() for loaders that download files themselves (3D models): Cloudflare first, the Vercel copy if that fails. */
export async function fetchMedia(path: string, init?: RequestInit): Promise<Response> {
  if (MEDIA_BASE) {
    try {
      const res = await fetch(mediaUrl(path), init);
      if (res.ok) return res;
    } catch {} // blocked or down: the Vercel copy below
  }
  return fetch(fallbackUrl(path), init);
}
