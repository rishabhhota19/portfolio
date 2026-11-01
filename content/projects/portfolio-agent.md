---
title: AI Portfolio Agent (this site)
summary: Dumbledore, a Python LangGraph agent live on this site — hybrid RAG, a five-gate refusal pipeline, page navigation and 17 free LLMs on a ₹0/month stack.
org: Personal
period: Oct 2026
tags: [LangGraph, LangChain, RAG, FAISS, Python, RAGAS]
featured: true
order: 11
keywords: [this site, portfolio, chatbot, agent, dumbledore, how does this chat work, langgraph, langchain, rag, faiss, bm25, rerank, reranking, ragas, fastapi, python, evals, guardrails, refusal, navigation]
---

- **Status:** live in production on this site (rishabh-hota.vercel.app) since October 2026, serving real visitors, with error monitoring (Sentry) and evals on every push. The agent is called **Dumbledore**; the chat window is just its interface.
- **Agent:** a LangGraph graph in Python (FastAPI on Vercel):
  - **route:** greetings, contact questions and "take me to …" requests get an instant answer with no LLM call;
  - **retrieve:** hybrid search, combining FAISS for meaning (BAAI bge-small-en-v1.5 embeddings, run inside the server with the same model on Cloudflare as the backup) with BM25 for keywords, merged with Reciprocal Rank Fusion. A cross-encoder re-ranker was A/B-tested and kept off (MRR@4 0.885 vs 0.962);
  - **respond:** 17 free LLMs across Groq, Gemini, Cloudflare Workers AI and OpenRouter, picked by question difficulty (fact, standard, reasoning). Budgets are reserved atomically in Redis, so many visitors at once never overload one model, and the switch between models is invisible.
- **Refusal pipeline:** five gates keep it on topic — rules, then a meaning check against on-topic and off-topic examples (both before any LLM), the prompt, an output check on every sentence before the visitor sees it (code and leaked instructions replaced; unknown links, phone numbers and other emails removed), and a cache that stores only clean answers. On 76 attack and off-topic prompts (follow-ups included): 0 leaks. On held-out prompts it refused 32 of 33, 24 of them before any LLM, with 0 false refusals on 47 real recruiter questions.
- **Agent actions:** it takes visitors to the page they ask for ("open the LCSNet paper") and offers "take me there" buttons under answers. Targets come from an allow-list of the site's own pages, so no one can be sent elsewhere.
- **Answer bank:** common questions, asked any way, are answered instantly from checked answers: an embedding match with a safety margin (0 wrong answers on held-out paraphrases).
- **Security:** a Next.js gateway in front of the agent checks for bots, validates input, rate-limits per visitor and enforces a daily budget.
- **Memory:** lives only in the visitor's open tab. When the chat or the site is closed, it's gone, and only a short AI summary is logged to a Google Sheet.
- **Evals:** Python suites check retrieval, facts, guardrails, refusals, navigation and difficulty routing; RAGAS scores faithfulness, answer relevancy and context precision.
