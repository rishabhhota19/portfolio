import type { ReactNode } from "react";
import { site } from "@/lib/content";

/** Where "Book a call" goes: the Google Calendar booking page once content/site.json has one (`booking`), and until
 * then an email with the subject already filled in, so the button always leads somewhere. */
export const bookingHref =
  site.booking || `mailto:${site.email}?subject=${encodeURIComponent("15-min call with Rishabh")}`;
const external = bookingHref.startsWith("http");

export function CalendarIcon({ className = "size-[1.05em]" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3.5" y="5" width="17" height="15" rx="3" />
      <path d="M3.5 10h17M8.5 3v4M15.5 3v4M9.5 15l2 2 3.5-3.5" />
    </svg>
  );
}

export function SparkleIcon({ className = "size-[1.05em]" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round">
      <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z" />
      <path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z" />
    </svg>
  );
}

export function CubeIcon({ className = "size-[1em]" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round">
      <path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z" />
      <path d="M4 7.5l8 4.5 8-4.5M12 12v9" />
    </svg>
  );
}

/** The one filled gold button: "Book a call". `from` says where it was clicked, for Umami. */
export function BookCall({ from, className = "", children = "Book a call" }: { from: string; className?: string; children?: ReactNode }) {
  return (
    <a
      href={bookingHref}
      {...(external ? { target: "_blank", rel: "noreferrer" } : {})}
      data-umami-event="book_call"
      data-umami-event-from={from}
      className={`btn-primary ${className}`}
    >
      <CalendarIcon />
      {children}
    </a>
  );
}
