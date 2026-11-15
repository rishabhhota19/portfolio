"use client";

export type AgentView = "agent" | "site";

/** Phones and tablets have no room for the agent beside the site, so the two take turns: Agent · Site. */
export function AgentTabs({ view, onPick, className = "" }: { view: AgentView; onPick: (view: AgentView) => void; className?: string }) {
  const tab = (name: AgentView, label: string) => (
    <button
      type="button"
      role="tab"
      aria-selected={view === name}
      onClick={() => onPick(name)}
      className={`flex items-center gap-2 rounded-full px-4 py-2 text-sm transition-colors duration-300 ${
        view === name ? "bg-accent text-accent-ink" : "text-muted hover:text-ink"
      }`}
    >
      {name === "agent" ? <span className={`size-1.5 rounded-full ${view === name ? "bg-accent-ink" : "bg-accent"}`} aria-hidden /> : null}
      {label}
    </button>
  );
  return (
    <div role="tablist" aria-label="Show the agent or the site" className={`inline-flex rounded-full border border-rule bg-surface p-1 ${className}`}>
      {tab("agent", "Agent")}
      {tab("site", "Site")}
    </div>
  );
}
