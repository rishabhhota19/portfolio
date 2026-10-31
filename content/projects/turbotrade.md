---
title: TurboTrade — Zerodha MCP trading copilot
summary: A chat copilot that researches, plans and trades Indian markets using LangChain, Groq and Zerodha's Kite MCP.
org: Simplilearn (on-site project)
period: Apr – May 2025
tags: [MCP, LangChain, Groq, RAG, Fintech]
featured: true
order: 3
keywords: [turbotrade, turbotrader, zerodha, kite, mcp, trading, stocks, groq, langchain, fintech, oauth]
---

## What it does
TurboTrade puts research, planning and trading on Indian markets into one chat.

A user can ask: "Show my live P&L, scan for bullish breakouts, then sell half my HDFC Bank."

## How it works
- **LangChain** handles orchestration, **Groq** provides fast reasoning, and the **Zerodha Kite MCP server** streams secure, real-time account data.
- The agent fetches positions through MCP, blends fresh news using LangChain RAG, and streams insights.
- One-tap options let the user buy, sell, set stops or queue deeper research.

## Safety design
- MCP keeps API keys out of prompts, and OAuth scopes guard capital.
- Every step is logged and reversible.
- Models and brokers can be swapped, and custom research feeds plugged in, without rewrites.
- Built to stay compliant with Indian rules.
