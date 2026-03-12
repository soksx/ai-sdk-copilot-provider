import { createJsonErrorResponseHandler } from "@ai-sdk/provider-utils"
import { copilotErrorDataSchema } from "../copilot-error"

export const copilotFailedResponseHandler: any = createJsonErrorResponseHandler({
  errorSchema: copilotErrorDataSchema,
  errorToMessage: (data) => data.error.message,
})
