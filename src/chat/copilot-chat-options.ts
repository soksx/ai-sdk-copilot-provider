import { z } from "zod"

export type CopilotChatModelId = string

export const copilotProviderOptions = z.object({
  user: z.string().optional(),
  reasoningEffort: z.string().optional(),
  textVerbosity: z.string().optional(),
  thinking_budget: z.number().optional(),
})
