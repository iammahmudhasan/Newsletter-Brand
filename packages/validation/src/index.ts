import { z } from "zod";

export const emailSchema = z
  .string({ required_error: "Email is required", invalid_type_error: "Email is required" })
  .trim()
  .min(1, "Email is required")
  .toLowerCase()
  .email("Please provide a valid email address")
  .max(254, "Email address is too long");

export const subscribeRequestSchema = z.object({
  email: emailSchema,
  source: z.string().trim().default("web_form"),
});

export type SubscribeRequest = z.infer<typeof subscribeRequestSchema>;

export const campaignCreateSchema = z.object({
  title: z
    .string({ required_error: "Campaign title is required and must be text", invalid_type_error: "Campaign title is required and must be text" })
    .trim()
    .min(1, "Campaign title is required and must be text")
    .max(255, "Campaign title cannot exceed 255 characters"),
  subject: z
    .string({ required_error: "Email subject is required and must be text", invalid_type_error: "Email subject is required and must be text" })
    .trim()
    .min(1, "Email subject is required and must be text")
    .max(255, "Email subject cannot exceed 255 characters"),
  previewText: z.string().max(255, "Preview text cannot exceed 255 characters").optional().default(""),
  contentHtml: z
    .string({ required_error: "Content HTML is required and must be text", invalid_type_error: "Content HTML is required and must be text" })
    .trim()
    .min(1, "Content HTML is required and must be text")
    .max(500_000, "Content HTML exceeds maximum size limit (500KB)"),
  contentPlain: z.string().max(500_000, "Content plain exceeds maximum size limit (500KB)").optional().default(""),
});

export type CampaignCreateInput = z.infer<typeof campaignCreateSchema>;

export const tokenQuerySchema = z.object({
  token: z.string().min(10, "Invalid token format"),
});

export const gdprRequestSchema = z.object({
  email: z
    .string({ required_error: "A valid email address is required", invalid_type_error: "A valid email address is required" })
    .trim()
    .min(1, "A valid email address is required"),
  purpose: z.enum(["data_export", "data_delete"], {
    errorMap: () => ({ message: "Invalid purpose. Must be 'data_export' or 'data_delete'" }),
  }),
});

export const emailWebhookEventSchema = z.object({
  type: z.string().optional(),
  event: z.string().optional(),
  eventType: z.string().optional(),
  messageId: z.string().optional(),
  email: z.string().optional(),
  data: z.record(z.any()).optional(),
});
