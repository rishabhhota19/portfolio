import "server-only";
import { checkBotId } from "botid/server";

/** Vercel BotID verdict. Off Vercel (local dev, `next start`) BotID can't run, so we allow. */
export async function isBot() {
  if (!process.env.VERCEL) return false;
  try {
    const verdict = await checkBotId();
    return verdict.isBot && !verdict.isVerifiedBot;
  } catch (err) {
    console.warn("[bot] BotID check failed — allowing request:", err);
    return false;
  }
}
