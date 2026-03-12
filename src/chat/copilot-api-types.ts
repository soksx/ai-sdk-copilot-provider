import type { JSONValue } from "@ai-sdk/provider";

type JsonRecord<T = never> = Record<string, JSONValue | JSONValue[] | T | T[] | undefined>;

interface CopilotSystemMessage extends JsonRecord<CopilotSystemContentPart> {
	role: "system";
	content: string | Array<CopilotSystemContentPart>;
}

interface CopilotSystemContentPart extends JsonRecord {
	type: "text";
	text: string;
}

interface CopilotUserMessage extends JsonRecord<CopilotContentPart> {
	role: "user";
	content: string | Array<CopilotContentPart>;
}

type CopilotContentPart = CopilotContentPartText | CopilotContentPartImage;

interface CopilotContentPartImage extends JsonRecord {
	type: "image_url";
	image_url: { url: string };
}

interface CopilotContentPartText extends JsonRecord {
	type: "text";
	text: string;
}

interface CopilotAssistantMessage extends JsonRecord<CopilotMessageToolCall> {
	role: "assistant";
	content?: string | null;
	tool_calls?: Array<CopilotMessageToolCall>;
	reasoning_text?: string;
	reasoning_opaque?: string;
}

interface CopilotMessageToolCall extends JsonRecord {
	type: "function";
	id: string;
	function: { arguments: string; name: string };
}

interface CopilotToolMessage extends JsonRecord {
	role: "tool";
	content: string;
	tool_call_id: string;
}

type CopilotMessage =
	| CopilotSystemMessage
	| CopilotUserMessage
	| CopilotAssistantMessage
	| CopilotToolMessage;

export type CopilotChatPrompt = Array<CopilotMessage>;
