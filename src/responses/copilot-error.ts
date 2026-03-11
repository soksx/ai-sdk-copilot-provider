import { z } from "zod"
import { createJsonErrorResponseHandler } from "@ai-sdk/provider-utils"

export const copilotErrorDataSchema = z.object({
  error: z.object({
    message: z.string(),
    type: z.string().nullish(),
    param: z.any().nullish(),
    code: z.union([z.string(), z.number()]).nullish(),
  }),
})

export type CopilotErrorData = z.infer<typeof copilotErrorDataSchema>

export const copilotFailedResponseHandler: any = createJsonErrorResponseHandler({
  errorSchema: copilotErrorDataSchema,
  errorToMessage: (data) => data.error.message,
})
