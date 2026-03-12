import {
  APICallError,
  type LanguageModelV3,
  type LanguageModelV3CallOptions,
  type LanguageModelV3Content,
  type LanguageModelV3FinishReason,
  type LanguageModelV3StreamPart,
  type LanguageModelV3Usage,
  type SharedV3ProviderMetadata,
  type SharedV3Warning,
} from "@ai-sdk/provider"
import {
  combineHeaders,
  createEventSourceResponseHandler,
  createJsonResponseHandler,
  generateId,
  parseProviderOptions,
  type ParseResult,
  postJsonToApi,
} from "@ai-sdk/provider-utils"
import { z } from "zod"
import type { CopilotConfig } from "./copilot-config"
import { copilotFailedResponseHandler } from "./copilot-error"
import { convertToCopilotResponsesInput } from "./convert-to-copilot-responses-input"
import { mapCopilotResponseFinishReason } from "./map-copilot-responses-finish-reason"
import type { CopilotResponsesIncludeOptions } from "./copilot-responses-api-types"
import { prepareResponsesTools } from "./copilot-responses-prepare-tools"
import type { CopilotResponsesModelId } from "./copilot-responses-settings"

const TOP_LOGPROBS_MAX = 20

const LOGPROBS_SCHEMA = z.array(
  z.object({
    token: z.string(),
    logprob: z.number(),
    top_logprobs: z.array(z.object({ token: z.string(), logprob: z.number() })),
  }),
)

export class CopilotResponsesLanguageModel implements LanguageModelV3 {
  readonly specificationVersion = "v3" as const
  readonly modelId: CopilotResponsesModelId
  private readonly config: CopilotConfig

  constructor(modelId: CopilotResponsesModelId, config: CopilotConfig) {
    this.modelId = modelId
    this.config = config
  }

  readonly supportedUrls: Record<string, RegExp[]> = {
    "image/*": [/^https?:\/\/.*$/],
    "application/pdf": [/^https?:\/\/.*$/],
  }

  get provider(): string {
    return this.config.provider
  }

  private async getArgs(options: LanguageModelV3CallOptions) {
    const warnings: Array<SharedV3Warning> = []
    const modelConfig = getResponsesModelConfig(this.modelId)

    if (options.topK != null) warnings.push({ type: "unsupported", feature: "topK" })
    if (options.seed != null) warnings.push({ type: "unsupported", feature: "seed" })
    if (options.presencePenalty != null) warnings.push({ type: "unsupported", feature: "presencePenalty" })
    if (options.frequencyPenalty != null) warnings.push({ type: "unsupported", feature: "frequencyPenalty" })
    if (options.stopSequences != null) warnings.push({ type: "unsupported", feature: "stopSequences" })

    const copilotOptions = await parseProviderOptions({
      provider: "copilot",
      providerOptions: options.providerOptions,
      schema: copilotResponsesProviderOptionsSchema,
    })

    const { input, warnings: inputWarnings } = await convertToCopilotResponsesInput({
      prompt: options.prompt,
      systemMessageMode: modelConfig.systemMessageMode,
      fileIdPrefixes: this.config.fileIdPrefixes,
      store: copilotOptions?.store ?? true,
    })

    warnings.push(...inputWarnings)

    const strictJsonSchema = copilotOptions?.strictJsonSchema ?? false
    let include: CopilotResponsesIncludeOptions = copilotOptions?.include

    const topLogprobs =
      typeof copilotOptions?.logprobs === "number"
        ? copilotOptions?.logprobs
        : copilotOptions?.logprobs === true
          ? TOP_LOGPROBS_MAX
          : undefined

    const baseArgs = {
      model: this.modelId,
      input,
      temperature: options.temperature,
      top_p: options.topP,
      max_output_tokens: options.maxOutputTokens,
      ...((options.responseFormat?.type === "json" || copilotOptions?.textVerbosity) && {
        text: {
          ...(options.responseFormat?.type === "json" && {
            format:
              options.responseFormat.schema != null
                ? {
                    type: "json_schema",
                    strict: strictJsonSchema,
                    name: options.responseFormat.name ?? "response",
                    description: options.responseFormat.description,
                    schema: options.responseFormat.schema,
                  }
                : { type: "json_object" },
          }),
          ...(copilotOptions?.textVerbosity && { verbosity: copilotOptions.textVerbosity }),
        },
      }),
      max_tool_calls: copilotOptions?.maxToolCalls,
      metadata: copilotOptions?.metadata,
      parallel_tool_calls: copilotOptions?.parallelToolCalls,
      previous_response_id: copilotOptions?.previousResponseId,
      store: copilotOptions?.store,
      user: copilotOptions?.user,
      instructions: copilotOptions?.instructions,
      service_tier: copilotOptions?.serviceTier,
      include,
      prompt_cache_key: copilotOptions?.promptCacheKey,
      safety_identifier: copilotOptions?.safetyIdentifier,
      top_logprobs: topLogprobs,
      ...(modelConfig.isReasoningModel &&
        (copilotOptions?.reasoningEffort != null || copilotOptions?.reasoningSummary != null) && {
          reasoning: {
            ...(copilotOptions?.reasoningEffort != null && { effort: copilotOptions.reasoningEffort }),
            ...(copilotOptions?.reasoningSummary != null && { summary: copilotOptions.reasoningSummary }),
          },
        }),
      ...(modelConfig.requiredAutoTruncation && { truncation: "auto" }),
    }

    if (modelConfig.isReasoningModel) {
      if ((baseArgs as any).temperature != null) {
        warnings.push({
          type: "unsupported",
          feature: "temperature",
          details: "temperature is not supported for reasoning models",
        })
      }
      if ((baseArgs as any).top_p != null) {
        warnings.push({
          type: "unsupported",
          feature: "topP",
          details: "topP is not supported for reasoning models",
        })
      }
    }

    const { tools: copilotTools, toolChoice: copilotToolChoice, toolWarnings } = prepareResponsesTools({
      tools: options.tools,
      toolChoice: options.toolChoice,
      strictJsonSchema,
    })

    return {
      args: { ...baseArgs, tools: copilotTools, tool_choice: copilotToolChoice },
      warnings: [...warnings, ...toolWarnings],
    }
  }

  async doGenerate(options: LanguageModelV3CallOptions): Promise<LanguageModelV3["doGenerate"] extends (options: any) => Promise<infer R> ? R : never> {
    const { args: body, warnings } = await this.getArgs(options)
    const url = this.config.url({ path: "/responses", modelId: this.modelId })

    const { responseHeaders, value: response, rawValue: rawResponse } = await postJsonToApi({
      url,
      headers: combineHeaders(this.config.headers(), options.headers),
      body,
      failedResponseHandler: copilotFailedResponseHandler,
      successfulResponseHandler: createJsonResponseHandler(copilotResponsesResponseSchema),
      abortSignal: options.abortSignal,
      fetch: this.config.fetch,
    })

    if (response.error) {
      throw new APICallError({
        message: response.error.message,
        url,
        requestBodyValues: body,
        statusCode: 400,
        responseHeaders,
        responseBody: rawResponse as string,
        isRetryable: false,
      })
    }

    const content: Array<LanguageModelV3Content> = []
    const logprobs: Array<z.infer<typeof LOGPROBS_SCHEMA>> = []

    for (const part of response.output) {
      switch (part.type) {
        case "reasoning": {
          if (part.summary.length === 0) part.summary.push({ type: "summary_text", text: "" })
          for (const summary of part.summary) {
            content.push({
              type: "reasoning" as const,
              text: summary.text,
              providerMetadata: { copilot: { itemId: part.id, reasoningEncryptedContent: part.encrypted_content ?? null } },
            })
          }
          break
        }

        case "message": {
          for (const contentPart of part.content) {
            if (options.providerOptions?.copilot?.logprobs && contentPart.logprobs) {
              logprobs.push(contentPart.logprobs)
            }
            content.push({
              type: "text",
              text: contentPart.text,
              providerMetadata: { copilot: { itemId: part.id } },
            })
            for (const annotation of contentPart.annotations) {
              if (annotation.type === "url_citation") {
                content.push({
                  type: "source",
                  sourceType: "url",
                  id: this.config.generateId?.() ?? generateId(),
                  url: annotation.url,
                  title: annotation.title,
                })
              }
            }
          }
          break
        }

        case "function_call": {
          content.push({
            type: "tool-call",
            toolCallId: part.call_id,
            toolName: part.name,
            input: part.arguments,
            providerMetadata: { copilot: { itemId: part.id } },
          })
          break
        }
      }
    }

    const providerMetadata: SharedV3ProviderMetadata = {
      copilot: { responseId: response.id },
    }

    if (logprobs.length > 0) providerMetadata.copilot.logprobs = logprobs
    if (typeof response.service_tier === "string") providerMetadata.copilot.serviceTier = response.service_tier

    return {
      content,
      finishReason: mapCopilotResponseFinishReason({
        finishReason: response.incomplete_details?.reason,
        hasFunctionCall: response.output.some((p: any) => p.type === "function_call"),
        isJsonResponseFromTool:
          options.responseFormat?.type === "json" &&
          response.output.some((p: any) => p.type === "function_call"),
      }),
      usage: {
        inputTokens: {
          total: response.usage.input_tokens ?? undefined,
          noCache: undefined,
          cacheRead: response.usage.input_tokens_details?.cached_tokens ?? undefined,
          cacheWrite: undefined,
        },
        outputTokens: {
          total: response.usage.output_tokens ?? undefined,
          text: undefined,
          reasoning: response.usage.output_tokens_details?.reasoning_tokens ?? undefined,
        },
      },
      request: { body },
      response: {
        id: response.id,
        timestamp: new Date(response.created_at * 1000),
        modelId: response.model,
        headers: responseHeaders,
        body: rawResponse,
      },
      providerMetadata,
      warnings,
    }
  }

  async doStream(options: LanguageModelV3CallOptions): Promise<LanguageModelV3["doStream"] extends (options: any) => Promise<infer R> ? R : never> {
    const { args: body, warnings } = await this.getArgs(options)

    const { responseHeaders, value: response } = await postJsonToApi({
      url: this.config.url({ path: "/responses", modelId: this.modelId }),
      headers: combineHeaders(this.config.headers(), options.headers),
      body: { ...body, stream: true },
      failedResponseHandler: copilotFailedResponseHandler,
      successfulResponseHandler: createEventSourceResponseHandler(copilotResponsesChunkSchema),
      abortSignal: options.abortSignal,
      fetch: this.config.fetch,
    })

    let finishReason: LanguageModelV3FinishReason = { unified: "unknown", raw: undefined }
    const usage: LanguageModelV3Usage = {
      inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: undefined, text: undefined, reasoning: undefined },
    }
    const logprobs: Array<z.infer<typeof LOGPROBS_SCHEMA>> = []
    let responseId: string | null = null
    const ongoingToolCalls: Record<number, { toolName: string; toolCallId: string } | undefined> = {}
    let hasFunctionCall = false
    const activeReasoning: Record<
      number,
      { canonicalId: string; encryptedContent?: string | null; summaryParts: number[] }
    > = {}
    let currentReasoningOutputIndex: number | null = null
    let currentTextId: string | null = null
    let serviceTier: string | undefined

    return {
      stream: response.pipeThrough(
        new TransformStream<ParseResult<z.infer<typeof copilotResponsesChunkSchema>>, LanguageModelV3StreamPart>({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings })
          },

          transform(chunk, controller) {
            if (options.includeRawChunks) {
              controller.enqueue({ type: "raw" as const, rawValue: chunk.rawValue })
            }

            if (!chunk.success) {
              finishReason = { unified: "error", raw: undefined }
              controller.enqueue({ type: "error", error: chunk.error })
              return
            }

            const value = chunk.value

            if (isResponseOutputItemAddedChunk(value)) {
              if (value.item.type === "function_call") {
                ongoingToolCalls[value.output_index] = {
                  toolName: value.item.name,
                  toolCallId: value.item.call_id,
                }
                controller.enqueue({ type: "tool-input-start", id: value.item.call_id, toolName: value.item.name })
              } else if (value.item.type === "message") {
                currentTextId = value.item.id
                controller.enqueue({
                  type: "text-start",
                  id: value.item.id,
                  providerMetadata: { copilot: { itemId: value.item.id } },
                })
              } else if (isResponseOutputItemAddedReasoningChunk(value)) {
                activeReasoning[value.output_index] = {
                  canonicalId: value.item.id,
                  encryptedContent: value.item.encrypted_content,
                  summaryParts: [0],
                }
                currentReasoningOutputIndex = value.output_index
                controller.enqueue({
                  type: "reasoning-start",
                  id: `${value.item.id}:0`,
                  providerMetadata: {
                    copilot: { itemId: value.item.id, reasoningEncryptedContent: value.item.encrypted_content ?? null },
                  },
                })
              }
            } else if (isResponseOutputItemDoneChunk(value)) {
              if (value.item.type === "function_call") {
                ongoingToolCalls[value.output_index] = undefined
                hasFunctionCall = true
                controller.enqueue({ type: "tool-input-end", id: value.item.call_id })
                controller.enqueue({
                  type: "tool-call",
                  toolCallId: value.item.call_id,
                  toolName: value.item.name,
                  input: value.item.arguments,
                  providerMetadata: { copilot: { itemId: value.item.id } },
                })
              } else if (value.item.type === "message") {
                if (currentTextId) {
                  controller.enqueue({ type: "text-end", id: currentTextId })
                  currentTextId = null
                }
              } else if (isResponseOutputItemDoneReasoningChunk(value)) {
                const activeReasoningPart = activeReasoning[value.output_index]
                if (activeReasoningPart) {
                  for (const summaryIndex of activeReasoningPart.summaryParts) {
                    controller.enqueue({
                      type: "reasoning-end",
                      id: `${activeReasoningPart.canonicalId}:${summaryIndex}`,
                      providerMetadata: {
                        copilot: {
                          itemId: activeReasoningPart.canonicalId,
                          reasoningEncryptedContent: value.item.encrypted_content ?? null,
                        },
                      },
                    })
                  }
                  delete activeReasoning[value.output_index]
                  if (currentReasoningOutputIndex === value.output_index) {
                    currentReasoningOutputIndex = null
                  }
                }
              }
            } else if (isResponseFunctionCallArgumentsDeltaChunk(value)) {
              const toolCall = ongoingToolCalls[value.output_index]
              if (toolCall != null) {
                controller.enqueue({ type: "tool-input-delta", id: toolCall.toolCallId, delta: value.delta })
              }
            } else if (isResponseCreatedChunk(value)) {
              responseId = value.response.id
              controller.enqueue({
                type: "response-metadata",
                id: value.response.id,
                timestamp: new Date(value.response.created_at * 1000),
                modelId: value.response.model,
              })
            } else if (isTextDeltaChunk(value)) {
              if (!currentTextId) {
                currentTextId = value.item_id
                controller.enqueue({
                  type: "text-start",
                  id: currentTextId,
                  providerMetadata: { copilot: { itemId: value.item_id } },
                })
              }
              controller.enqueue({ type: "text-delta", id: currentTextId, delta: value.delta })
              if (options.providerOptions?.copilot?.logprobs && value.logprobs) {
                logprobs.push(value.logprobs)
              }
            } else if (isResponseReasoningSummaryTextDeltaChunk(value)) {
              const activeItem =
                currentReasoningOutputIndex !== null ? activeReasoning[currentReasoningOutputIndex] : null
              if (activeItem) {
                controller.enqueue({
                  type: "reasoning-delta",
                  id: `${activeItem.canonicalId}:${value.summary_index}`,
                  delta: value.delta,
                  providerMetadata: { copilot: { itemId: activeItem.canonicalId } },
                })
              }
            } else if (isResponseFinishedChunk(value)) {
              finishReason = mapCopilotResponseFinishReason({
                finishReason: value.response.incomplete_details?.reason,
                hasFunctionCall,
                isJsonResponseFromTool:
                  options.responseFormat?.type === "json" &&
                  hasFunctionCall,
              })
              usage.inputTokens.total = value.response.usage.input_tokens ?? undefined
              usage.outputTokens.total = value.response.usage.output_tokens ?? undefined
              usage.outputTokens.reasoning = value.response.usage.output_tokens_details?.reasoning_tokens ?? undefined
              usage.inputTokens.cacheRead = value.response.usage.input_tokens_details?.cached_tokens ?? undefined
              if (typeof value.response.service_tier === "string") {
                serviceTier = value.response.service_tier
              }
            } else if (isErrorChunk(value)) {
              controller.enqueue({ type: "error", error: value })
            }
          },

          flush(controller) {
            if (currentTextId) {
              controller.enqueue({ type: "text-end", id: currentTextId })
              currentTextId = null
            }

            const providerMetadata: SharedV3ProviderMetadata = {
              copilot: { responseId },
            }
            if (logprobs.length > 0) providerMetadata.copilot.logprobs = logprobs
            if (serviceTier !== undefined) providerMetadata.copilot.serviceTier = serviceTier

            controller.enqueue({ type: "finish", finishReason, usage, providerMetadata })
          },
        }),
      ),
      request: { body },
      response: { headers: responseHeaders },
    }
  }
}

// Schemas
const usageSchema = z.object({
  input_tokens: z.number(),
  input_tokens_details: z.object({ cached_tokens: z.number().nullish() }).nullish(),
  output_tokens: z.number(),
  output_tokens_details: z.object({ reasoning_tokens: z.number().nullish() }).nullish(),
})

const copilotResponsesResponseSchema = z.object({
  id: z.string(),
  created_at: z.number(),
  error: z.object({ code: z.string(), message: z.string() }).nullish(),
  model: z.string(),
  output: z.array(
    z.discriminatedUnion("type", [
      z.object({
        type: z.literal("message"),
        role: z.literal("assistant"),
        id: z.string(),
        content: z.array(
          z.object({
            type: z.literal("output_text"),
            text: z.string(),
            logprobs: LOGPROBS_SCHEMA.nullish(),
            annotations: z.array(
              z.discriminatedUnion("type", [
                z.object({
                  type: z.literal("url_citation"),
                  start_index: z.number(),
                  end_index: z.number(),
                  url: z.string(),
                  title: z.string(),
                }),
              ]),
            ),
          }),
        ),
      }),
      z.object({
        type: z.literal("reasoning"),
        id: z.string(),
        encrypted_content: z.string().nullish(),
        summary: z.array(z.object({ type: z.literal("summary_text"), text: z.string() })),
      }),
      z.object({
        type: z.literal("function_call"),
        call_id: z.string(),
        name: z.string(),
        arguments: z.string(),
        id: z.string(),
      }),
    ]),
  ),
  service_tier: z.string().nullish(),
  incomplete_details: z.object({ reason: z.string() }).nullish(),
  usage: usageSchema,
})

// Stream chunk schemas
const textDeltaChunkSchema = z.object({
  type: z.literal("response.output_text.delta"),
  item_id: z.string(),
  delta: z.string(),
  logprobs: LOGPROBS_SCHEMA.nullish(),
})

const errorChunkSchema = z.object({
  type: z.literal("error"),
  code: z.string(),
  message: z.string(),
  param: z.string().nullish(),
  sequence_number: z.number(),
})

const responseFinishedChunkSchema = z.object({
  type: z.enum(["response.completed", "response.incomplete"]),
  response: z.object({
    incomplete_details: z.object({ reason: z.string() }).nullish(),
    usage: usageSchema,
    service_tier: z.string().nullish(),
  }),
})

const responseCreatedChunkSchema = z.object({
  type: z.literal("response.created"),
  response: z.object({
    id: z.string(),
    created_at: z.number(),
    model: z.string(),
    service_tier: z.string().nullish(),
  }),
})

const responseOutputItemAddedSchema = z.object({
  type: z.literal("response.output_item.added"),
  output_index: z.number(),
  item: z.discriminatedUnion("type", [
    z.object({ type: z.literal("message"), id: z.string() }),
    z.object({ type: z.literal("reasoning"), id: z.string(), encrypted_content: z.string().nullish() }),
    z.object({ type: z.literal("function_call"), id: z.string(), call_id: z.string(), name: z.string(), arguments: z.string() }),
  ]),
})

const responseOutputItemDoneSchema = z.object({
  type: z.literal("response.output_item.done"),
  output_index: z.number(),
  item: z.discriminatedUnion("type", [
    z.object({ type: z.literal("message"), id: z.string() }),
    z.object({ type: z.literal("reasoning"), id: z.string(), encrypted_content: z.string().nullish() }),
    z.object({ type: z.literal("function_call"), id: z.string(), call_id: z.string(), name: z.string(), arguments: z.string(), status: z.literal("completed") }),
  ]),
})

const responseFunctionCallArgumentsDeltaSchema = z.object({
  type: z.literal("response.function_call_arguments.delta"),
  item_id: z.string(),
  output_index: z.number(),
  delta: z.string(),
})

const responseReasoningSummaryTextDeltaSchema = z.object({
  type: z.literal("response.reasoning_summary_text.delta"),
  item_id: z.string(),
  summary_index: z.number(),
  delta: z.string(),
})

const copilotResponsesChunkSchema = z.union([
  textDeltaChunkSchema,
  responseFinishedChunkSchema,
  responseCreatedChunkSchema,
  responseOutputItemAddedSchema,
  responseOutputItemDoneSchema,
  responseFunctionCallArgumentsDeltaSchema,
  responseReasoningSummaryTextDeltaSchema,
  errorChunkSchema,
  z.object({ type: z.string() }),
])

// Type guards
function isTextDeltaChunk(chunk: z.infer<typeof copilotResponsesChunkSchema>): chunk is z.infer<typeof textDeltaChunkSchema> {
  return chunk.type === "response.output_text.delta"
}

function isResponseOutputItemAddedChunk(chunk: z.infer<typeof copilotResponsesChunkSchema>): chunk is z.infer<typeof responseOutputItemAddedSchema> {
  return chunk.type === "response.output_item.added"
}

function isResponseOutputItemAddedReasoningChunk(chunk: z.infer<typeof copilotResponsesChunkSchema>): chunk is z.infer<typeof responseOutputItemAddedSchema> & { item: { type: "reasoning"; id: string; encrypted_content?: string | null } } {
  return isResponseOutputItemAddedChunk(chunk) && chunk.item.type === "reasoning"
}

function isResponseOutputItemDoneChunk(chunk: z.infer<typeof copilotResponsesChunkSchema>): chunk is z.infer<typeof responseOutputItemDoneSchema> {
  return chunk.type === "response.output_item.done"
}

function isResponseOutputItemDoneReasoningChunk(chunk: z.infer<typeof copilotResponsesChunkSchema>): chunk is z.infer<typeof responseOutputItemDoneSchema> & { item: { type: "reasoning"; id: string; encrypted_content?: string | null } } {
  return isResponseOutputItemDoneChunk(chunk) && chunk.item.type === "reasoning"
}

function isResponseFinishedChunk(chunk: z.infer<typeof copilotResponsesChunkSchema>): chunk is z.infer<typeof responseFinishedChunkSchema> {
  return chunk.type === "response.completed" || chunk.type === "response.incomplete"
}

function isResponseCreatedChunk(chunk: z.infer<typeof copilotResponsesChunkSchema>): chunk is z.infer<typeof responseCreatedChunkSchema> {
  return chunk.type === "response.created"
}

function isResponseFunctionCallArgumentsDeltaChunk(chunk: z.infer<typeof copilotResponsesChunkSchema>): chunk is z.infer<typeof responseFunctionCallArgumentsDeltaSchema> {
  return chunk.type === "response.function_call_arguments.delta"
}

function isResponseReasoningSummaryTextDeltaChunk(chunk: z.infer<typeof copilotResponsesChunkSchema>): chunk is z.infer<typeof responseReasoningSummaryTextDeltaSchema> {
  return chunk.type === "response.reasoning_summary_text.delta"
}

function isErrorChunk(chunk: z.infer<typeof copilotResponsesChunkSchema>): chunk is z.infer<typeof errorChunkSchema> {
  return chunk.type === "error"
}

// Model config
type ResponsesModelConfig = {
  isReasoningModel: boolean
  systemMessageMode: "remove" | "system" | "developer"
  requiredAutoTruncation: boolean
}

function getResponsesModelConfig(modelId: string): ResponsesModelConfig {
  const defaults = {
    requiredAutoTruncation: false,
    systemMessageMode: "system" as const,
  }

  if (modelId.startsWith("gpt-5-chat")) {
    return { ...defaults, isReasoningModel: false }
  }

  if (
    modelId.startsWith("o") ||
    modelId.startsWith("gpt-5") ||
    modelId.startsWith("codex-") ||
    modelId.startsWith("computer-use")
  ) {
    if (modelId.startsWith("o1-mini") || modelId.startsWith("o1-preview")) {
      return { ...defaults, isReasoningModel: true, systemMessageMode: "remove" }
    }
    return { ...defaults, isReasoningModel: true, systemMessageMode: "developer" }
  }

  return { ...defaults, isReasoningModel: false }
}

const copilotResponsesProviderOptionsSchema = z.object({
  include: z.array(z.enum(["reasoning.encrypted_content", "file_search_call.results", "message.output_text.logprobs"])).nullish(),
  instructions: z.string().nullish(),
  logprobs: z.union([z.boolean(), z.number().min(1).max(TOP_LOGPROBS_MAX)]).optional(),
  maxToolCalls: z.number().nullish(),
  metadata: z.any().nullish(),
  parallelToolCalls: z.boolean().nullish(),
  previousResponseId: z.string().nullish(),
  promptCacheKey: z.string().nullish(),
  reasoningEffort: z.string().nullish(),
  reasoningSummary: z.string().nullish(),
  safetyIdentifier: z.string().nullish(),
  serviceTier: z.enum(["auto", "flex", "priority"]).nullish(),
  store: z.boolean().nullish(),
  strictJsonSchema: z.boolean().nullish(),
  textVerbosity: z.enum(["low", "medium", "high"]).nullish(),
  user: z.string().nullish(),
})

export type CopilotResponsesProviderOptions = z.infer<typeof copilotResponsesProviderOptionsSchema>
