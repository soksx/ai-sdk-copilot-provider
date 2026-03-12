import {
	type LanguageModelV3CallOptions,
	type SharedV3Warning,
	UnsupportedFunctionalityError,
} from "@ai-sdk/provider";

export function prepareResponsesTools({
	tools,
	toolChoice,
	strictJsonSchema = false,
}: {
	tools: LanguageModelV3CallOptions["tools"];
	toolChoice?: LanguageModelV3CallOptions["toolChoice"];
	strictJsonSchema?: boolean;
}): {
	tools:
		| undefined
		| Array<{
				type: "function";
				function: {
					name: string;
					description: string | undefined;
					parameters: unknown;
					strict?: boolean;
				};
		  }>;
	toolChoice:
		| { type: "function"; function: { name: string } }
		| "auto"
		| "none"
		| "required"
		| undefined;
	toolWarnings: SharedV3Warning[];
} {
	tools = tools?.length ? tools : undefined;
	const toolWarnings: SharedV3Warning[] = [];

	if (tools == null) {
		return { tools: undefined, toolChoice: undefined, toolWarnings };
	}

	const responsesTools: Array<{
		type: "function";
		function: {
			name: string;
			description: string | undefined;
			parameters: unknown;
			strict?: boolean;
		};
	}> = [];

	for (const tool of tools) {
		if (tool.type === "provider") {
			toolWarnings.push({ type: "unsupported", feature: `tool: ${tool.id}` });
		} else {
			responsesTools.push({
				type: "function",
				function: {
					name: tool.name,
					description: tool.description,
					parameters: tool.inputSchema,
					strict: strictJsonSchema ? true : undefined,
				},
			});
		}
	}

	if (toolChoice == null) {
		return { tools: responsesTools, toolChoice: undefined, toolWarnings };
	}

	const type = toolChoice.type;

	switch (type) {
		case "auto":
		case "none":
		case "required":
			return { tools: responsesTools, toolChoice: type, toolWarnings };
		case "tool":
			return {
				tools: responsesTools,
				toolChoice: { type: "function", function: { name: toolChoice.toolName } },
				toolWarnings,
			};
		default: {
			const _exhaustiveCheck: never = type;
			throw new UnsupportedFunctionalityError({
				functionality: `tool choice type: ${_exhaustiveCheck}`,
			});
		}
	}
}
