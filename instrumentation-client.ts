import { initBotId } from "botid/client/core";

// Vercel BotID: invisible bot checks on the endpoints that spend LLM tokens or send email.
initBotId({
  protect: [
    { path: "/api/chat", method: "POST" },
    { path: "/api/lead", method: "POST" },
  ],
});
