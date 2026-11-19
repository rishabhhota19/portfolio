---
title: Product Launch System
summary: "AI automation with a human in the loop: one unified system that connects three teams, from programme sheet to print-ready, editable designer artwork. In use as an internal tool."
org: "On-site project · Sr. AI Researcher"
period: Aug 2026 – present
tags: [Agentic AI, Human in the loop, Claude Agent Skills, Multi-agent, Adobe Illustrator, Evals, Python]
featured: true
order: 1
keywords: [product launch system, program launch, launch system, brochure, human in the loop, three teams, page content, designer handoff, illustrator, editable artwork, gates, learning pipeline, steve, ai program launcher, internal tool, unified software]
skills: ["Python", "agentic AI and harness engineering", "AI and agentic AI orchestration", "multi-agent systems", "Claude Code", "Claude Science and Claude Skills", "agent and LLM evaluation", "agent and LLM guardrailing and deployment", "automation engineering", "loop engineering", "system design", "Generative AI", "GenAI applications", "OOP"]
---

## The problem
Launching a new programme meant a brochure and its launch material, and that work moved between **three teams that never
shared one tool**: product managers who own the facts and the story, a content team that reviews and approves every
word, and designers who rebuild the approved pages by hand in Adobe Illustrator. Each hand-off was an email, a PDF and a
round of corrections, and the same mistakes came back launch after launch.

## What Rishabh built
**One unified system that runs the whole launch, end to end, with a person deciding at every step that needs judgement.**
It ships as a Claude Agent Skill ("Steve, the AI Program launcher") that each team runs in its own chair, on the same
files, with the same rules.

- **Product manager's chair.** The programme sheet is read in, a ten-question intake gate fills what is missing, and
  the market positioning is researched and recorded. Every section's words are drafted from the sources the PM gave
  (never invented: a doubt is asked, not guessed) and approved on a **Page Content** web page, where a fast, cheap
  agent makes each change the PM asks for. On **page zero** the PM picks up to three reference brochures from a library
  and says, in their own words, what to take from each.
- **The build.** A design director turns those picks into a brief; the pages are built, measured and exported to a
  print-intent PDF. Page height is predicted to **about 3% of the real render** before anything is drawn, so nothing is
  clipped. A complete **29-page draft comes out in one pass.**
- **Content team's chair.** Draft 1 goes out for approval from the PM's own Gmail, and the reviewers' comments come
  back as tracked items, each closed or answered, never lost in a thread.
- **Designer's chair.** The approved pages are handed over as a package and rebuilt **natively in Adobe Illustrator**
  behind identity and editability gates (live text, real layers, no flattened pictures of words), then finished in a
  **pair room** where Claude, Adobe and the designer work on the same file together.

## How it holds quality
- **Rules are build failures, not advice.** House style, locked boilerplate, spelling, banned claims, copy floors per
  course, stat sources and their age: a draft that breaks one does not export.
- **Images are licensed or they do not ship.** The design team's own assets come first; anything else is searched,
  judged on a contact sheet by a person, and recorded with its source, licence and credit, above a 2000 px print floor.
- **Every step is recorded in order.** The flow lives in code: the next missing step is printed with its exact question,
  and Draft 1 is refused while a step is missing.
- **Model routing.** Drafting runs on the session's own model; the Page Content edits run on a small, fast model; the
  learners, director and builders are separate agents that resume where they stopped instead of starting over.

## It learns from every team
Every person's edits, in every chair, are captured by a **learning pipeline** and turned into rules and references for
the next launch: what a designer fixed by hand becomes a check the build makes itself. Tested versions are released
to everyone at once, and each session updates itself to the latest release before it starts.

## In numbers
- **88 versions in eleven weeks** (v1 in August 2026 to v88 in late October), each tested and released.
- **156 scripts and 166 tests** behind one skill.
- **Three teams, one tool:** product, content and design work from the same files, the same rules and the same history.
- In use as an **internal tool** for programme launches.

## Stack
Claude Agent Skills, Python, multi-agent orchestration (director, drafters, learners,
builders), Haiku for fast edits, Google Drive, Sheets and Gmail, Adobe Illustrator through its connector, PyMuPDF for
measuring PDFs, GitHub releases for versioning.
