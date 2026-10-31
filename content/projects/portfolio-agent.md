---
title: This site's recruiter agent
summary: A LangGraph RAG agent that answers questions about Rishabh — built on a ₹0/month stack across Vercel, Cloudflare and Upstash.
org: Personal
period: 2026
tags: [LangGraph, RAG, Upstash Vector, Cloudflare AI Gateway, Next.js]
featured: false
order: 11
keywords: [this site, portfolio, chatbot, agent, how does this chat work, langgraph, rag, upstash, cloudflare, vercel, fallback, google sheets]
---

- A LangGraph agent with two steps:
  - **retrieve:** RAG over this site's own content in Upstash Vector;
  - **respond:** streamed answers through a fallback chain of free LLMs — Groq, then Gemini, then Cloudflare Workers AI, routed via Cloudflare AI Gateway.
- Chat memory lives only in the visitor's open tab. When the chat or the site is closed, the history is gone.
- Only a short AI summary of each chat is logged, to a Google Sheet.
- Rate limits, bot protection and a daily budget keep it free at 10k+ visitors a month.
