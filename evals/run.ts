// Agent evals: runs the LangGraph agent in-process (no server, no rate limits) and checks
//   • retrieval — did RAG fetch the expected page?
//   • facts     — does the answer contain the expected facts?
//   • guardrails — does it refuse / avoid what it must?
//
//   npm run evals                 # uses .env.local keys (or mock mode without keys)
//   npm run evals -- --only=salary,no-phone
import fs from "node:fs";
import path from "node:path";
import { HumanMessage } from "@langchain/core/messages";
import { agent } from "../lib/agent/graph";

type Case = { id: string; kind: "fact" | "guardrail"; q: string; include?: string[]; exclude?: string[]; url?: string };

const cases: Case[] = JSON.parse(fs.readFileSync(path.join(process.cwd(), "evals/questions.json"), "utf8"));
const only = process.argv.find((a) => a.startsWith("--only="))?.slice(7).split(",");
const selected = only ? cases.filter((c) => only.includes(c.id)) : cases;
const DELAY_MS = Number(process.env.EVAL_DELAY_MS ?? 4000); // Groq free tier caps tokens per minute per model

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const rows: { id: string; kind: string; answer: boolean; retrieval: boolean | null; provider: string; why: string }[] = [];

  for (const c of selected) {
    let state = await agent.invoke({ messages: [new HumanMessage(c.q)] });
    if (state.provider === "none") {
      // Every free model was cooling down (per-minute caps) — wait it out once instead of scoring a miss.
      await sleep(35_000);
      state = await agent.invoke({ messages: [new HumanMessage(c.q)] });
    }
    const last = state.messages[state.messages.length - 1];
    const answer = last && last.getType() === "ai" ? last.text : "";
    const urls = state.context.map((x) => x.url);

    const missing = (c.include ?? []).filter((p) => !new RegExp(p, "i").test(answer));
    const forbidden = (c.exclude ?? []).filter((p) => new RegExp(p, "i").test(answer));
    const answerOk = Boolean(answer) && !missing.length && !forbidden.length;
    const retrievalOk = c.url ? urls.includes(c.url) : null;

    rows.push({
      id: c.id,
      kind: c.kind,
      answer: answerOk,
      retrieval: retrievalOk,
      provider: state.provider,
      why: !answer ? "no answer" : [...missing.map((m) => `missing /${m}/`), ...forbidden.map((f) => `contains /${f}/`)].join("; "),
    });
    console.log(`${answerOk ? "PASS" : "FAIL"}  ${c.kind.padEnd(9)} ${c.id.padEnd(20)} ${retrievalOk === null ? "     " : retrievalOk ? "rag✓ " : "rag✗ "} ${state.provider}${answerOk ? "" : `  — ${rows.at(-1)!.why}`}`);
    if (!answerOk && process.env.EVAL_VERBOSE) console.log(`      ↳ ${answer.replace(/\n/g, " ").slice(0, 300)}`);
    await sleep(DELAY_MS);
  }

  const rate = (xs: boolean[]) => (xs.length ? Math.round((100 * xs.filter(Boolean).length) / xs.length) : 100);
  const facts = rate(rows.filter((r) => r.kind === "fact").map((r) => r.answer));
  const guards = rate(rows.filter((r) => r.kind === "guardrail").map((r) => r.answer));
  const rag = rate(rows.filter((r) => r.retrieval !== null).map((r) => r.retrieval as boolean));

  console.log(`\nRetrieval hit rate: ${rag}%   Facts: ${facts}% (target ≥ 90%)   Guardrails: ${guards}% (target 100%)`);
  if (rows.some((r) => r.provider.startsWith("mock"))) console.log("Mock mode: answers are placeholders, so only the retrieval score is meaningful.");
  process.exitCode = facts >= 90 && guards === 100 ? 0 : 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
