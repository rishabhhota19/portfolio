---
title: How the AI agent on this site works (and why it costs ₹0)
summary: A Python LangGraph agent, hybrid RAG with FAISS + BM25 and re-ranking, free LLMs with fallbacks, and RAGAS evals.
date: 2026-10-31
keywords: [blog, this site, how it works, langgraph, rag, faiss, bm25, reranking, ragas, architecture, free stack]
---

Recruiters rarely have time to read a whole portfolio, so I put an agent on this site that answers questions about my work. Here's how it's built.

## The graph
The agent is a small **LangGraph** graph written in Python:

1. **route:** simple messages (hi, "how do I contact him?", prompt-injection attempts) get an instant reply without calling an LLM. That saves the free quota for real questions.
2. **retrieve:** hybrid search over this site's own content.
   - **FAISS** finds chunks with similar *meaning*, using Gemini embeddings.
   - **BM25** finds exact *keywords*.
   - **Reciprocal Rank Fusion** merges the two rankings.
3. **rerank:** a cross-encoder (bge-reranker-base) reads the question and each chunk together, and keeps the best 4.
4. **respond:** an LLM answers from those chunks only, and streams the reply token by token.

## Free models, with fallbacks
Free LLM tiers have rate limits, so one provider is never enough. The agent tries **Groq gpt-oss-120b** first, then **Gemini Flash-Lite**, then smaller Groq models. A model that fails is skipped for a while and the next one answers.

## Security in front, AI behind
- The browser never talks to the Python agent directly.
- A Next.js gateway checks for bots, validates input, rate-limits each visitor and enforces a daily budget.
- Only then does it call the agent, using a shared secret.

## Memory that disappears
Chat history lives only in your open browser tab. When you close the chat or leave the site, it's gone. All I keep is a short AI-written summary, plus your details only if you chose to share them.

## Measuring it
- An eval suite checks that retrieval finds the right page, that answers contain the right facts, and that guardrails hold: no phone numbers, no leaked prompt, no invented claims.
- **RAGAS** scores faithfulness, answer relevancy and context precision, using a free model as the judge.
