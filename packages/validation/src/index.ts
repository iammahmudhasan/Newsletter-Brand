import { z } from "zod";

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .email("Please provide a valid email address")
  .max(254, "Email address is too long");

export const subscribeRequestSchema = z.object({
  email: emailSchema,
  source: z.string().trim().default("web_form"),
});

export type SubscribeRequest = z.infer<typeof subscribeRequestSchema>;

export const campaignCreateSchema = z.object({
  title: z.string().min(3, "Campaign title must be at least 3 characters"),
  subject: z.string().min(3, "Subject line must be at least 3 characters"),
  previewText: z.string().optional().default(""),
  contentHtml: z.string().min(10, "Content HTML must be at least 10 characters"),
  contentPlain: z.string().optional().default(""),
});

export type CampaignCreateInput = z.infer<typeof campaignCreateSchema>;

export const tokenQuerySchema = z.object({
  token: z.string().min(10, "Invalid token format"),
});

export const emailWebhookEventSchema = z.object({
  type: z.string().optional(),
  event: z.string().optional(),
  eventType: z.string().optional(),
  messageId: z.string().optional(),
  email: z.string().optional(),
  data: z.record(z.any()).optional(),
});
