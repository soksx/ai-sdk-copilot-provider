import type { LanguageModelV3FinishReason } from "@ai-sdk/provider"

export function mapCopilotResponseFinishReason({
  finishReason,
  hasFunctionCall,
}: {
  finishReason?: string
  hasFunctionCall: boolean
}): LanguageModelV3FinishReason {
  const raw = finishReason ?? undefined

  if (hasFunctionCall) {
    return { unified: "tool-calls", raw }
  }

  switch (finishReason) {
    case "stop":
    case "complete":
      return { unified: "stop", raw }
    case "length":
    case "max_tokens":
      return { unified: "length", raw }
    case "content_filter":
      return { unified: "content-filter", raw }
    default:
      return { unified: "stop", raw }
  }
}
