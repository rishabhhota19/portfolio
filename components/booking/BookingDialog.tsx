"use client";

import dynamic from "next/dynamic";
import { useEffect, useRef, useState } from "react";
import { OPEN_BOOKING_EVENT } from "@/components/chat/events";

// The card's code loads on the first click, not with every page.
const BookingCard = dynamic(() => import("./BookingCard").then((m) => m.BookingCard), { ssr: false });

/** The booking card over the page, opened by any "Book a call" button (components/site/cta.tsx). */
export function BookingDialog() {
  const [from, setFrom] = useState<string | null>(null);
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const open = (e: Event) => setFrom((e as CustomEvent<{ from: string }>).detail?.from || "site");
    window.addEventListener(OPEN_BOOKING_EVENT, open);
    // A link can open it too: the 3D site's "Book a call" lands on /?book=3d. Read once, then the URL is cleaned.
    const url = new URL(window.location.href);
    const linked = url.searchParams.get("book");
    if (linked !== null) {
      setFrom(linked.replace(/[^a-z0-9 -]/gi, "").slice(0, 30) || "link");
      url.searchParams.delete("book");
      window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
    }
    return () => window.removeEventListener(OPEN_BOOKING_EVENT, open);
  }, []);

  useEffect(() => {
    const d = ref.current;
    if (from && d && !d.open) d.showModal();
  }, [from]);

  return (
    <dialog
      ref={ref}
      onClose={() => setFrom(null)}
      onClick={(e) => e.target === ref.current && ref.current?.close()} // a click on the backdrop
      aria-label="Book a call with Rishabh"
      className="m-auto w-[min(36rem,calc(100vw-2rem))] max-h-[calc(100dvh-2rem)] overflow-y-auto rounded-3xl bg-transparent p-0 text-ink backdrop:bg-black/60 backdrop:backdrop-blur-sm"
    >
      {from ? (
        <div className="relative">
          <button
            type="button"
            onClick={() => ref.current?.close()}
            aria-label="Close"
            className="absolute right-4 top-4 z-10 grid size-9 place-items-center rounded-full border border-rule bg-paper text-muted hover:text-ink"
          >
            <svg viewBox="0 0 24 24" className="size-4" aria-hidden fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M6 6l12 12M18 6 6 18" />
            </svg>
          </button>
          <BookingCard from={from} />
        </div>
      ) : null}
    </dialog>
  );
}
