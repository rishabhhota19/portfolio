---
title: How the AI agent on this site works (and why it costs ₹0)
summary: Dumbledore, a Python LangGraph agent — retrieval measured at the depth the writer reads, a grounding check, a five-gate refusal pipeline, page navigation, and free LLMs with fallbacks.
date: 2026-10-31
keywords: [blog, this site, how it works, langgraph, rag, embeddings, bm25, reranking, cross-encoder, grounding check, hallucination, ragas, architecture, free stack, refusal, guardrails, navigation, dumbledore]
---

Recruiters rarely have time to read a whole portfolio, so I put an agent on this site that answers questions about my work. It's called **Dumbledore**; the chat window is only its interface. Here's how it's built.

*Updated 19 November 2026: retrieval was remeasured and rebuilt, and a grounding check was added.*

## The graph
The agent is a small **LangGraph** graph written in Python:

1. **route:** simple messages (hi, "how do I contact him?", "take me to his projects") get an instant reply without calling an LLM. That saves the free quota for real questions.
2. **retrieve:** the question is embedded once with one open-source model, BAAI bge-small-en-v1.5 — an 8-bit ONNX build that runs inside the server itself, about 3 ms a question, with the same model on Cloudflare Workers AI as the backup, so every route gives the same vectors. The 8 chunks closest in *meaning* are the candidates: one matrix product over the site's chunks. **BM25** keyword search is the fallback for when nothing can embed the question. It used to be fused into every ranking; measured at the depth the writer actually reads, that pulled keyword collisions up ("research" found a service page before the papers), so the vectors rank alone. A question about a whole section (all my papers, every place I have worked) finds one page-sized document for that section, every item one line.
3. **scope:** checks the question is about my work before any LLM sees it (more below).
4. **rerank:** a second opinion. A 4 MB cross-encoder (ms-marco-TinyBERT-L-2, 8-bit) reads the question with each candidate; its order is fused with the vectors' order, the vectors counting double, and the writer reads the first 2, 4 or 6 by the question's level. I measured eight cross-encoders first: deciding the order alone, every one of them ranked below the vectors on this site, so the reranker votes rather than decides.
5. **respond:** an LLM answers from those chunks only.
6. **check:** every sentence is checked before it reaches you, and then a second model reads the finished answer against the passages it was written from. A number, date or result the passages don't support — the commonest slip is one project's result given to another — is corrected or removed. The answer streams while this runs, so you may see it replaced as it finishes.

## Saying no: the refusal pipeline
An agent on a portfolio shouldn't write code, essays or opinions for anyone. Five gates keep it on topic:
- **Rules:** harmful requests, jailbreaks, personal questions and off-topic tasks are refused instantly.
- **Meaning:** the question's embedding (already computed for retrieval, so it's free) is compared with on-topic and off-topic example questions. Clearly off-topic means refused, still with no LLM call. A follow-up like "give me the link of the paper" is judged together with the previous question.
- **Prompt:** the model answers only from my profile, or replies with one exact refusal sentence. If a small model refuses a real question about me, a different model gets a second opinion.
- **Output:** the server holds each sentence until it's checked. Code or leaked instructions replace the whole answer; unknown links, phone numbers and other people's emails are removed.
- **Cache:** only clean, on-topic answers are ever cached.

On 76 attack and off-topic prompts there were 0 leaks. On prompts written after the rules (a held-out set), it refused 32 of 33, 24 of them before any LLM, with 0 false refusals on 47 real recruiter questions.

## An agent that acts
Ask "open the LCSNet paper" and Dumbledore takes you there. After an answer it offers "take me there" buttons for the pages it was about. Where to go is decided by rules over an allow-list of this site's pages, so it can't be talked into sending anyone elsewhere.

## Free models, with fallbacks
Free LLM tiers have rate limits, so one provider is never enough. Each question gets a difficulty level (fact, standard, reasoning), and each level has its own pool of free models across **Groq**, **Gemini**, **Cloudflare Workers AI** and **OpenRouter**. Before calling a model, the backend reserves its budget atomically in Redis, so many visitors at once never pile onto one model, and it trims older turns if a long conversation doesn't fit. The switch is invisible. Common questions are answered instantly from a bank of checked answers. Only when every free model is used up does the chat pause, until the limits reset.

## Security in front, AI behind
- The browser never talks to the Python agent directly.
- A Next.js gateway checks for bots, validates input, rate-limits each visitor and enforces a daily budget.
- Only then does it call the agent, using a shared secret.

## Memory that disappears
Chat history lives only in your open browser tab. When you close the chat or leave the site, it's gone. All I keep is a short AI-written summary, plus your details only if you chose to share them.

## Measuring it
- Eval suites check that the right page is among the chunks the writer actually reads (not just somewhere in the results), that answers contain the right facts and never another project's numbers, that guardrails and refusals hold, and that navigation lands on the right page.
- Every retrieval choice above was a measurement first: BM25's place, the eight rerankers, the section pages. The eval that compares the reranker with the vectors alone runs on every push, with no API keys.
- **RAGAS** scores faithfulness, answer relevancy and context precision, using a free model as the judge.
