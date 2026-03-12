import {
	type LanguageModelV3Prompt,
	type SharedV3Warning,
	UnsupportedFunctionalityError,
} from "@ai-sdk/provider";
import { convertToBase64 } from "@ai-sdk/provider-utils";

type SystemMessageMode = "remove" | "system" | "developer";

interface CopilotResponsesInput {
	messages: Array<any>;
	instructions?: string;
}

export async function convertToCopilotResponsesInput({
	prompt,
	systemMessageMode,
	fileIdPrefixes: _fileIdPrefixes,
	store: _store,
}: {
	prompt: LanguageModelV3Prompt;
	systemMessageMode: SystemMessageMode;
	fileIdPrefixes?: readonly string[];
	store: boolean;
}): Promise<{ input: CopilotResponsesInput; warnings: Array<SharedV3Warning> }> {
	const warnings: Array<SharedV3Warning> = [];
	const messages: Array<any> = [];
	let instructions: string | undefined;

	for (const { role, content } of prompt) {
		switch (role) {
			case "system": {
				const systemContent = content;
				if (systemMessageMode === "system") {
					messages.push({ role: "system", content: systemContent });
				} else if (systemMessageMode === "developer") {
					messages.push({ role: "developer", content: systemContent });
				}
				// For "remove" mode, we skip adding system messages
				break;
			}

			case "user": {
				if (content.length === 1 && content[0].type === "text") {
					messages.push({ role: "user", content: content[0].text });
				} else {
					messages.push({
						role: "user",
						content: content.map((part) => {
							switch (part.type) {
								case "text":
									return { type: "input_text", text: part.text };
								case "file": {
									if (part.mediaType.startsWith("image/")) {
										const mediaType = part.mediaType === "image/*" ? "image/jpeg" : part.mediaType;
										return {
											type: "input_image",
											image_url:
												part.data instanceof URL
													? part.data.toString()
													: `data:${mediaType};base64,${convertToBase64(part.data)}`,
										};
									} else if (part.mediaType === "application/pdf") {
										return {
											type: "input_file",
											filename: part.filename,
											file_data:
												part.data instanceof URL
													? part.data.toString()
													: `data:${part.mediaType};base64,${convertToBase64(part.data)}`,
										};
									} else {
										throw new UnsupportedFunctionalityError({
											functionality: `file part media type ${part.mediaType}`,
										});
									}
								}
								default:
									throw new UnsupportedFunctionalityError({
										functionality: `content part type ${(part as any).type}`,
									});
							}
						}),
					});
				}
				break;
			}

			case "assistant": {
				const assistantContent: Array<any> = [];

				for (const part of content) {
					switch (part.type) {
						case "text":
							assistantContent.push({ type: "output_text", text: part.text });
							break;
						case "reasoning":
							// Handle reasoning content
							if (part.text) {
								assistantContent.push({ type: "reasoning", text: part.text });
							}
							break;
						case "tool-call":
							assistantContent.push({
								type: "function_call",
								call_id: part.toolCallId,
								name: part.toolName,
								arguments: typeof part.input === "string" ? part.input : JSON.stringify(part.input),
							});
							break;
						case "tool-result":
							// Tool results in assistant content - skip
							break;
					}
				}

				messages.push({ role: "assistant", content: assistantContent });
				break;
			}

			case "tool": {
				for (const toolResponse of content) {
					if (toolResponse.type !== "tool-result") continue;

					const output = toolResponse.output;
					let resultContent: string;

					switch (output.type) {
						case "text":
						case "error-text":
							resultContent = output.value;
							break;
						case "json":
						case "error-json":
							resultContent = JSON.stringify(output.value);
							break;
						case "content":
							resultContent = JSON.stringify(output.value);
							break;
						case "execution-denied":
							resultContent = output.reason ?? "Tool execution denied.";
							break;
						default:
							resultContent = JSON.stringify((output as any).value);
					}

					messages.push({
						type: "function_call_output",
						call_id: toolResponse.toolCallId,
						output: resultContent,
					});
				}
				break;
			}

			default: {
				const _exhaustiveCheck: never = role;
				throw new Error(`Unsupported role: ${_exhaustiveCheck}`);
			}
		}
	}

	return {
		input: {
			messages,
			instructions,
		},
		warnings,
	};
}
