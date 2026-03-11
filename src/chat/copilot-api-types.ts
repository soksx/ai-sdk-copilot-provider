import type { JSONValue } from "@ai-sdk/provider"

export type CopilotChatPrompt = Array<CopilotMessage>

export type CopilotMessage =
  | CopilotSystemMessage
  | CopilotUserMessage
  | CopilotAssistantMessage
  | CopilotToolMessage

type JsonRecord<T = never> = Record<string, JSONValue | JSONValue[] | T | T[] | undefined>

export interface CopilotSystemMessage extends JsonRecord<CopilotSystemContentPart> {
  role: "system"
  content: string | Array<CopilotSystemContentPart>
}

export interface CopilotSystemContentPart extends JsonRecord {
  type: "text"
  text: string
}

export interface CopilotUserMessage extends JsonRecord<CopilotContentPart> {
  role: "user"
  content: string | Array<CopilotContentPart>
}

export type CopilotContentPart = CopilotContentPartText | CopilotContentPartImage

export interface CopilotContentPartImage extends JsonRecord {
  type: "image_url"
  image_url: { url: string }
}

export interface CopilotContentPartText extends JsonRecord {
  type: "text"
  text: string
}

export interface CopilotAssistantMessage extends JsonRecord<CopilotMessageToolCall> {
  role: "assistant"
  content?: string | null
  tool_calls?: Array<CopilotMessageToolCall>
  reasoning_text?: string
  reasoning_opaque?: string
}

export interface CopilotMessageToolCall extends JsonRecord {
  type: "function"
  id: string
  function: { arguments: string; name: string }
}

export interface CopilotToolMessage extends JsonRecord {
  role: "tool"
  content: string
  tool_call_id: string
}
