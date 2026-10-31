---
title: How the AI agent on this site works (and why it costs ₹0)
summary: LangGraph, RAG over Upstash Vector, a fallback chain of free LLMs, and chat memory that disappears when you leave.
date: 2026-10-31
keywords: [blog, this site, how it works, langgraph, rag, architecture, free stack]
---

Recruiters rarely have time to read a whole portfolio, so I put an agent on this site that answers questions about my work. Here's how it's built.

## The graph
The agent is a small **LangGraph** graph with two nodes:

1. **retrieve:** the question (plus the previous one, for follow-ups) is embedded and searched against my site content in **Upstash Vector**. The same markdown files that render these pages are chunked and indexed, so the agent and the site never disagree.
2. **respond:** a short always-on profile, plus the top retrieved chunks, goes to the model. The answer streams back token by token.

## Free models, with fallbacks
Free LLM tiers have daily caps, so one provider is never enough. Every call goes through **Cloudflare AI Gateway**, which gives me logs, token analytics and caching, and walks a chain:

- Groq `gpt-oss-120b` → Gemini Flash-Lite → smaller Groq models → Cloudflare Workers AI.
- When a provider returns 429, it's put on a short cooldown and the next one answers.
- If everything is exhausted, the chat falls back to pre-written answers and a contact form, so nobody sees an error.

## Memory that disappears
Chat history lives only in your open browser tab. When you close the chat or leave the site, it's gone. All I keep is a short AI-written summary — what you asked about, and your details only if you chose to share them. It lands in a Google Sheet I check.

## Keeping it free
- Pages are static and served from Vercel's CDN.
- Bot protection, per-visitor rate limits and a daily budget, stored in Upstash Redis, stop anyone from burning the free quotas.
- The whole thing runs comfortably within free tiers at 10k+ visitors a month.
