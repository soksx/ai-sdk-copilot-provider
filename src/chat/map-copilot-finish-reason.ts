import type { LanguageModelV3FinishReason } from "@ai-sdk/provider"

export function mapCopilotFinishReason({
  finishReason,
  isJsonResponseFromTool,
}: {
  finishReason: string | null | undefined
  isJsonResponseFromTool?: boolean
}): LanguageModelV3FinishReason {
  const raw = finishReason ?? undefined

  switch (finishReason) {
    case "stop":
      return { unified: "stop", raw }
    case "length":
      return { unified: "length", raw }
    case "content_filter":
      return { unified: "content-filter", raw }
    case "function_call":
    case "tool_calls":
      // When using JSON response format, the model may use a tool internally
      // but we should return 'stop' instead of 'tool-calls' since the tool
      // is just a JSON formatting mechanism, not an actual tool to execute
      return { unified: isJsonResponseFromTool ? "stop" : "tool-calls", raw }
    default:
      return { unified: "other", raw }
  }
}
