import type { LanguageModelV3FinishReason } from "@ai-sdk/provider";

export function mapCopilotResponseFinishReason({
	finishReason,
	hasFunctionCall,
	isJsonResponseFromTool,
}: {
	finishReason?: string;
	hasFunctionCall: boolean;
	isJsonResponseFromTool?: boolean;
}): LanguageModelV3FinishReason {
	const raw = finishReason ?? undefined;

	if (hasFunctionCall) {
		// When using JSON response format, the model may use a tool internally
		// but we should return 'stop' instead of 'tool-calls' since the tool
		// is just a JSON formatting mechanism, not an actual tool to execute
		return { unified: isJsonResponseFromTool ? "stop" : "tool-calls", raw };
	}

	switch (finishReason) {
		case "stop":
		case "complete":
			return { unified: "stop", raw };
		case "length":
		case "max_tokens":
			return { unified: "length", raw };
		case "content_filter":
			return { unified: "content-filter", raw };
		default:
			return { unified: "stop", raw };
	}
}
