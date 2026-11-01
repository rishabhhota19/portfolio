---
title: AI Portfolio Agent (this site)
summary: A Python LangGraph agent, live in production on this site, with hybrid RAG (FAISS + BM25 fused with RRF) that answers questions about Rishabh — on a ₹0/month stack.
org: Personal
period: Oct 2026
tags: [LangGraph, LangChain, RAG, FAISS, Python, RAGAS]
featured: true
order: 11
keywords: [this site, portfolio, chatbot, agent, how does this chat work, langgraph, langchain, rag, faiss, bm25, rerank, reranking, ragas, fastapi, python, evals]
---

- **Status:** live in production on this site (rishabh-hota.vercel.app) since October 2026, serving real visitors, with error monitoring (Sentry) and evals on every push.
- **Agent:** a LangGraph graph in Python (FastAPI on Vercel) with four steps:
  - **route:** greetings, contact questions and prompt-injection attempts get an instant answer with no LLM call;
  - **retrieve:** hybrid search, combining FAISS for meaning (Gemini embeddings) with BM25 for keywords, merged with Reciprocal Rank Fusion;
  - **rerank:** keeps the 4 best chunks in RRF order. A cross-encoder (bge-reranker-base) was A/B-tested on the eval set and kept off because it ranked worse (MRR@4 0.885 vs 0.962);
  - **respond:** streams the answer from 7 free LLMs (Groq, Gemini, OpenRouter). The backend tracks each model's tokens and requests against its free limits, trims long conversations to fit, and switches models invisibly.
- **Security:** a Next.js gateway in front of the agent checks for bots, validates input, rate-limits per visitor and enforces a daily budget.
- **Memory:** lives only in the visitor's open tab. When the chat or the site is closed, it's gone, and only a short AI summary is logged to a Google Sheet.
- **Evals:** a Python suite checks retrieval, facts and guardrails, and RAGAS scores faithfulness, answer relevancy and context precision.
