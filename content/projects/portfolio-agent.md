---
title: AI Portfolio Agent (this site)
summary: A Python LangGraph agent with hybrid RAG (FAISS + BM25 + re-ranking) that answers questions about Rishabh — on a ₹0/month stack.
org: Personal
period: Oct 2026
tags: [LangGraph, LangChain, RAG, FAISS, Python, RAGAS]
featured: true
order: 11
keywords: [this site, portfolio, chatbot, agent, how does this chat work, langgraph, langchain, rag, faiss, bm25, rerank, reranking, ragas, fastapi, python, evals]
---

- **Agent:** a LangGraph graph in Python (FastAPI on Vercel) with four steps:
  - **route:** greetings, contact questions and prompt-injection attempts get an instant answer with no LLM call;
  - **retrieve:** hybrid search, combining FAISS for meaning (Gemini embeddings) with BM25 for keywords, merged with Reciprocal Rank Fusion;
  - **rerank:** a cross-encoder (bge-reranker-base) keeps the 4 most relevant chunks;
  - **respond:** streams the answer from a chain of free LLMs (Groq gpt-oss, then Gemini). If one hits a rate limit, the next answers.
- **Security:** a Next.js gateway in front of the agent checks for bots, validates input, rate-limits per visitor and enforces a daily budget.
- **Memory:** lives only in the visitor's open tab. When the chat or the site is closed, it's gone, and only a short AI summary is logged to a Google Sheet.
- **Evals:** a Python suite checks retrieval, facts and guardrails, and RAGAS scores faithfulness, answer relevancy and context precision.
