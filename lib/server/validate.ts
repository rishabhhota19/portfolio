import "server-only";
import { z } from "zod";
import { LIMITS } from "@/lib/chat-types";

const message = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().max(4000),
});

export const chatRequest = z.object({
  sessionId: z.uuid().optional(),
  conversationId: z.uuid(),
  page: z.string().max(200).default("/"),
  messages: z
    .array(message)
    .min(1)
    .max(LIMITS.maxHistory)
    .refine((m) => m[m.length - 1].role === "user" && m[m.length - 1].content.trim().length > 0, "last message must be from the user")
    .refine((m) => m[m.length - 1].content.length <= LIMITS.maxMessageChars, "message too long"),
});

export const endRequest = z.object({
  sessionId: z.uuid().optional(),
  conversationId: z.uuid(),
  token: z.string().max(200).nullable(),
  startedAt: z.iso.datetime(),
  endedAt: z.iso.datetime(),
  reason: z.enum(["closed_chat", "left_site", "tab_hidden", "lead_submitted"]),
  page: z.string().max(200).default("/"),
  messages: z.array(message.extend({ content: z.string().max(LIMITS.maxLoggedChars) })).max(LIMITS.maxLoggedMessages),
});

export const leadRequest = endRequest.extend({
  lead: z.object({
    name: z.string().trim().min(1).max(80),
    email: z.email().max(120),
    company: z.string().trim().max(80).default(""),
    role: z.string().trim().max(80).default(""),
    phone: z.string().trim().max(30).regex(/^[+\d\s().-]*$/, "digits only").default(""),
    note: z.string().trim().max(600).default(""),
  }),
});

const short = (max: number) => z.string().trim().max(max).default("");

export const visitRequest = z.object({
  sessionId: z.uuid(),
  startedAt: z.iso.datetime(),
  activeSeconds: z.number().int().min(0).max(86_400),
  pages: z.array(z.string().max(200).regex(/^\//)).max(60),
  actions: z.array(z.string().regex(/^[a-z_]{1,40}$/)).max(60),
  referrer: short(300),
  utm: short(200),
  screen: short(20),
  language: short(20),
  timezone: short(60),
});

export const liveRequest = z.object({
  sessionId: z.uuid(),
  page: z.string().max(200).regex(/^\//),
  first: z.boolean().optional(),
  referrer: short(300),
  utm: short(200),
});

export const json = (data: unknown, status = 200, headers?: HeadersInit) =>
  Response.json(data, { status, headers: { "cache-control": "no-store", ...headers } });
