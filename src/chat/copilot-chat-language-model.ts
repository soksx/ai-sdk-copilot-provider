import {
  APICallError,
  InvalidResponseDataError,
  type LanguageModelV3,
  type LanguageModelV3CallOptions,
  type LanguageModelV3Content,
  type LanguageModelV3FinishReason,
  type LanguageModelV3FunctionTool,
  type LanguageModelV3StreamPart,
  type LanguageModelV3Usage,
  type SharedV3ProviderMetadata,
  type SharedV3Warning,
} from "@ai-sdk/provider"
import {
  combineHeaders,
  createEventSourceResponseHandler,
  createJsonErrorResponseHandler,
  createJsonResponseHandler,
  type FetchFunction,
  generateId,
  isParsableJson,
  parseProviderOptions,
  type ParseResult,
  postJsonToApi,
  type ResponseHandler,
} from "@ai-sdk/provider-utils"
import { z } from "zod"
import { convertToCopilotChatMessages } from "./convert-to-copilot-chat-messages"
import { getResponseMetadata } from "./get-response-metadata"
import { mapCopilotFinishReason } from "./map-copilot-finish-reason"
import { type CopilotChatModelId, copilotProviderOptions } from "./copilot-chat-options"
import { defaultCopilotErrorStructure, type ProviderErrorStructure } from "../copilot-error"

export type CopilotChatConfig = {
  provider: string
  headers: () => Record<string, string | undefined>
  url: (options: { modelId: string; path: string }) => string
  fetch?: FetchFunction
  includeUsage?: boolean
  errorStructure?: ProviderErrorStructure<any>
  supportsStructuredOutputs?: boolean
  supportedUrls?: () => Record<string, RegExp[]>
}

export class CopilotChatLanguageModel implements LanguageModelV3 {
  readonly specificationVersion = "v3" as const
  readonly supportsStructuredOutputs: boolean
  readonly modelId: CopilotChatModelId
  private readonly config: CopilotChatConfig
  private readonly failedResponseHandler: ResponseHandler<APICallError>
  private readonly chunkSchema

  constructor(modelId: CopilotChatModelId, config: CopilotChatConfig) {
    this.modelId = modelId
    this.config = config

    const errorStructure = config.errorStructure ?? defaultCopilotErrorStructure
    this.chunkSchema = createCopilotChatChunkSchema(errorStructure.errorSchema)
    this.failedResponseHandler = createJsonErrorResponseHandler(errorStructure)
    this.supportsStructuredOutputs = config.supportsStructuredOutputs ?? false
  }

  get provider(): string {
    return this.config.provider
  }

  private get providerOptionsName(): string {
    return this.config.provider.split(".")[0].trim()
  }

  get supportedUrls(): Record<string, RegExp[]> {
    return this.config.supportedUrls?.() ?? {}
  }

  private async getArgs(options: LanguageModelV3CallOptions) {
    const warnings: Array<SharedV3Warning> = []

    const compatibleOptions = Object.assign(
      (await parseProviderOptions({
        provider: "copilot",
        providerOptions: options.providerOptions,
        schema: copilotProviderOptions,
      })) ?? {},
      (await parseProviderOptions({
        provider: this.providerOptionsName,
        providerOptions: options.providerOptions,
        schema: copilotProviderOptions,
      })) ?? {},
    )

    if (options.topK != null) {
      warnings.push({ type: "unsupported", feature: "topK" })
    }

    if (options.responseFormat?.type === "json" && options.responseFormat.schema != null && !this.supportsStructuredOutputs) {
      warnings.push({
        type: "unsupported",
        feature: "responseFormat",
        details: "JSON response format schema is only supported with structuredOutputs",
      })
    }

    const { tools: openaiTools, toolChoice: openaiToolChoice, toolWarnings } = prepareTools({
      tools: options.tools,
      toolChoice: options.toolChoice,
    })

    warnings.push(...toolWarnings)

    return {
      args: {
        model: this.modelId,
        user: compatibleOptions.user,
        max_tokens: options.maxOutputTokens,
        temperature: options.temperature,
        top_p: options.topP,
        frequency_penalty: options.frequencyPenalty,
        presence_penalty: options.presencePenalty,
        response_format:
          options.responseFormat?.type === "json"
            ? this.supportsStructuredOutputs === true && options.responseFormat.schema != null
              ? {
                  type: "json_schema",
                  json_schema: {
                    schema: options.responseFormat.schema,
                    name: options.responseFormat.name ?? "response",
                    description: options.responseFormat.description,
                  },
                }
              : { type: "json_object" }
            : undefined,
        stop: options.stopSequences,
        seed: options.seed,
        ...Object.fromEntries(
          Object.entries(options.providerOptions?.[this.providerOptionsName] ?? {}).filter(
            ([key]) => !Object.keys(copilotProviderOptions.shape).includes(key),
          ),
        ),
        reasoning_effort: compatibleOptions.reasoningEffort,
        verbosity: compatibleOptions.textVerbosity,
        messages: convertToCopilotChatMessages(options.prompt),
        tools: openaiTools,
        tool_choice: openaiToolChoice,
        thinking_budget: compatibleOptions.thinking_budget,
      },
      warnings,
    }
  }

  async doGenerate(options: LanguageModelV3CallOptions): Promise<LanguageModelV3["doGenerate"] extends (options: any) => Promise<infer R> ? R : never> {
    const { args, warnings } = await this.getArgs(options)
    const body = JSON.stringify(args)

    const { responseHeaders, value: responseBody, rawValue: rawResponse } = await postJsonToApi({
      url: this.config.url({ path: "/chat/completions", modelId: this.modelId }),
      headers: combineHeaders(this.config.headers(), options.headers),
      body: args,
      failedResponseHandler: this.failedResponseHandler,
      successfulResponseHandler: createJsonResponseHandler(CopilotChatResponseSchema),
      abortSignal: options.abortSignal,
      fetch: this.config.fetch,
    })

    const choice = responseBody.choices[0]
    const content: Array<LanguageModelV3Content> = []

    const text = choice.message.content
    if (text != null && text.length > 0) {
      content.push({
        type: "text",
        text,
        providerMetadata: choice.message.reasoning_opaque
          ? { copilot: { reasoningOpaque: choice.message.reasoning_opaque } }
          : undefined,
      })
    }

    const reasoning = choice.message.reasoning_text
    if (reasoning != null && reasoning.length > 0) {
      content.push({
        type: "reasoning",
        text: reasoning,
        providerMetadata: choice.message.reasoning_opaque
          ? { copilot: { reasoningOpaque: choice.message.reasoning_opaque } }
          : undefined,
      })
    }

    if (choice.message.tool_calls != null) {
      for (const toolCall of choice.message.tool_calls) {
        content.push({
          type: "tool-call",
          toolCallId: toolCall.id ?? generateId(),
          toolName: toolCall.function.name,
          input: toolCall.function.arguments!,
          providerMetadata: choice.message.reasoning_opaque
            ? { copilot: { reasoningOpaque: choice.message.reasoning_opaque } }
            : undefined,
        })
      }
    }

    const providerMetadata: SharedV3ProviderMetadata = {
      [this.providerOptionsName]: {},
    }

    const completionTokenDetails = responseBody.usage?.completion_tokens_details
    if (completionTokenDetails?.accepted_prediction_tokens != null) {
      providerMetadata[this.providerOptionsName].acceptedPredictionTokens =
        completionTokenDetails?.accepted_prediction_tokens
    }
    if (completionTokenDetails?.rejected_prediction_tokens != null) {
      providerMetadata[this.providerOptionsName].rejectedPredictionTokens =
        completionTokenDetails?.rejected_prediction_tokens
    }

    return {
      content,
      finishReason: mapCopilotFinishReason(choice.finish_reason),
      usage: {
        inputTokens: {
          total: responseBody.usage?.prompt_tokens ?? undefined,
          noCache: undefined,
          cacheRead: responseBody.usage?.prompt_tokens_details?.cached_tokens ?? undefined,
          cacheWrite: undefined,
        },
        outputTokens: {
          total: responseBody.usage?.completion_tokens ?? undefined,
          text: undefined,
          reasoning: responseBody.usage?.completion_tokens_details?.reasoning_tokens ?? undefined,
        },
      },
      providerMetadata,
      request: { body },
      response: {
        ...getResponseMetadata(responseBody),
        headers: responseHeaders,
        body: rawResponse,
      },
      warnings,
    }
  }

  async doStream(options: LanguageModelV3CallOptions): Promise<LanguageModelV3["doStream"] extends (options: any) => Promise<infer R> ? R : never> {
    const { args, warnings } = await this.getArgs(options)

    const body = {
      ...args,
      stream: true,
      stream_options: this.config.includeUsage ? { include_usage: true } : undefined,
    }

    const { responseHeaders, value: response } = await postJsonToApi({
      url: this.config.url({ path: "/chat/completions", modelId: this.modelId }),
      headers: combineHeaders(this.config.headers(), options.headers),
      body,
      failedResponseHandler: this.failedResponseHandler,
      successfulResponseHandler: createEventSourceResponseHandler(this.chunkSchema),
      abortSignal: options.abortSignal,
      fetch: this.config.fetch,
    })

    const toolCalls: Array<{
      id: string
      type: "function"
      function: { name: string; arguments: string }
      hasFinished: boolean
    }> = []

    let finishReason: LanguageModelV3FinishReason = { unified: "unknown", raw: undefined }
    const usage: LanguageModelV3Usage = {
      inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: undefined, text: undefined, reasoning: undefined },
    }
    let isFirstChunk = true
    const providerOptionsName = this.providerOptionsName
    let isActiveReasoning = false
    let isActiveText = false
    let reasoningOpaque: string | undefined

    return {
      stream: response.pipeThrough(
        new TransformStream<ParseResult<z.infer<typeof this.chunkSchema>>, LanguageModelV3StreamPart>({
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

            if ("error" in value) {
              finishReason = { unified: "error", raw: undefined }
              controller.enqueue({ type: "error", error: value.error.message })
              return
            }

            if (isFirstChunk) {
              isFirstChunk = false
              controller.enqueue({ type: "response-metadata", ...getResponseMetadata(value) })
            }

            if (value.usage != null) {
              const { prompt_tokens, completion_tokens, prompt_tokens_details, completion_tokens_details } =
                value.usage
              usage.inputTokens.total = prompt_tokens ?? undefined
              usage.outputTokens.total = completion_tokens ?? undefined
              if (completion_tokens_details?.reasoning_tokens != null) {
                usage.outputTokens.reasoning = completion_tokens_details?.reasoning_tokens
              }
              if (prompt_tokens_details?.cached_tokens != null) {
                usage.inputTokens.cacheRead = prompt_tokens_details?.cached_tokens
              }
            }

            const choice = value.choices[0]

            if (choice?.finish_reason != null) {
              finishReason = mapCopilotFinishReason(choice.finish_reason)
            }

            if (choice?.delta == null) return

            const delta = choice.delta

            if (delta.reasoning_opaque) {
              if (reasoningOpaque != null) {
                throw new InvalidResponseDataError({
                  data: delta,
                  message:
                    "Multiple reasoning_opaque values received in a single response. Only one thinking part per response is supported.",
                })
              }
              reasoningOpaque = delta.reasoning_opaque
            }

            const reasoningContent = delta.reasoning_text
            if (reasoningContent) {
              if (!isActiveReasoning) {
                controller.enqueue({
                  type: "reasoning-start",
                  id: "reasoning-0",
                  providerMetadata: reasoningOpaque ? { copilot: { reasoningOpaque } } : undefined,
                })
                isActiveReasoning = true
              }
              controller.enqueue({
                type: "reasoning-delta",
                id: "reasoning-0",
                delta: reasoningContent,
                providerMetadata: reasoningOpaque ? { copilot: { reasoningOpaque } } : undefined,
              })
            }

            if (delta.content) {
              if (isActiveReasoning && !isActiveText) {
                controller.enqueue({
                  type: "reasoning-end",
                  id: "reasoning-0",
                  providerMetadata: reasoningOpaque ? { copilot: { reasoningOpaque } } : undefined,
                })
                isActiveReasoning = false
              }

              if (!isActiveText) {
                controller.enqueue({
                  type: "text-start",
                  id: "txt-0",
                  providerMetadata: reasoningOpaque ? { copilot: { reasoningOpaque } } : undefined,
                })
                isActiveText = true
              }

              controller.enqueue({
                type: "text-delta",
                id: "txt-0",
                delta: delta.content,
                providerMetadata: reasoningOpaque ? { copilot: { reasoningOpaque } } : undefined,
              })
            }

            if (delta.tool_calls != null) {
              if (isActiveReasoning) {
                controller.enqueue({
                  type: "reasoning-end",
                  id: "reasoning-0",
                  providerMetadata: reasoningOpaque ? { copilot: { reasoningOpaque } } : undefined,
                })
                isActiveReasoning = false
              }
              for (const toolCallDelta of delta.tool_calls) {
                const index = toolCallDelta.index

                if (toolCalls[index] == null) {
                  if (toolCallDelta.id == null) {
                    throw new InvalidResponseDataError({
                      data: toolCallDelta,
                      message: `Expected 'id' to be a string.`,
                    })
                  }

                  if (toolCallDelta.function?.name == null) {
                    throw new InvalidResponseDataError({
                      data: toolCallDelta,
                      message: `Expected 'function.name' to be a string.`,
                    })
                  }

                  controller.enqueue({
                    type: "tool-input-start",
                    id: toolCallDelta.id,
                    toolName: toolCallDelta.function.name,
                    providerMetadata: reasoningOpaque ? { copilot: { reasoningOpaque } } : undefined,
                  })

                  toolCalls[index] = {
                    id: toolCallDelta.id,
                    type: "function",
                    function: {
                      name: toolCallDelta.function.name,
                      arguments: toolCallDelta.function.arguments ?? "",
                    },
                    hasFinished: false,
                  }

                  const toolCall = toolCalls[index]

                  if (toolCall.function?.name != null && toolCall.function?.arguments != null) {
                    if (toolCall.function.arguments.length > 0) {
                      controller.enqueue({
                        type: "tool-input-delta",
                        id: toolCall.id,
                        delta: toolCall.function.arguments,
                        providerMetadata: reasoningOpaque ? { copilot: { reasoningOpaque } } : undefined,
                      })
                    }

                    if (isParsableJson(toolCall.function.arguments)) {
                      controller.enqueue({
                        type: "tool-input-end",
                        id: toolCall.id,
                        providerMetadata: reasoningOpaque ? { copilot: { reasoningOpaque } } : undefined,
                      })
                      controller.enqueue({
                        type: "tool-call",
                        toolCallId: toolCall.id ?? generateId(),
                        toolName: toolCall.function.name,
                        input: toolCall.function.arguments,
                        providerMetadata: reasoningOpaque ? { copilot: { reasoningOpaque } } : undefined,
                      })
                      toolCall.hasFinished = true
                    }
                  }

                  continue
                }

                const toolCall = toolCalls[index]

                if (toolCall.hasFinished) continue

                if (toolCallDelta.function?.arguments != null) {
                  toolCall.function!.arguments += toolCallDelta.function?.arguments ?? ""
                }

                controller.enqueue({
                  type: "tool-input-delta",
                  id: toolCall.id,
                  delta: toolCallDelta.function.arguments ?? "",
                  providerMetadata: reasoningOpaque ? { copilot: { reasoningOpaque } } : undefined,
                })

                if (
                  toolCall.function?.name != null &&
                  toolCall.function?.arguments != null &&
                  isParsableJson(toolCall.function.arguments)
                ) {
                  controller.enqueue({
                    type: "tool-input-end",
                    id: toolCall.id,
                    providerMetadata: reasoningOpaque ? { copilot: { reasoningOpaque } } : undefined,
                  })
                  controller.enqueue({
                    type: "tool-call",
                    toolCallId: toolCall.id ?? generateId(),
                    toolName: toolCall.function.name,
                    input: toolCall.function.arguments,
                    providerMetadata: reasoningOpaque ? { copilot: { reasoningOpaque } } : undefined,
                  })
                  toolCall.hasFinished = true
                }
              }
            }
          },

          flush(controller) {
            if (isActiveReasoning) {
              controller.enqueue({
                type: "reasoning-end",
                id: "reasoning-0",
                providerMetadata: reasoningOpaque ? { copilot: { reasoningOpaque } } : undefined,
              })
            }

            if (isActiveText) {
              controller.enqueue({ type: "text-end", id: "txt-0" })
            }

            for (const toolCall of toolCalls.filter((tc) => !tc.hasFinished)) {
              controller.enqueue({ type: "tool-input-end", id: toolCall.id })
              controller.enqueue({
                type: "tool-call",
                toolCallId: toolCall.id ?? generateId(),
                toolName: toolCall.function.name,
                input: toolCall.function.arguments,
              })
            }

            const providerMetadata: SharedV3ProviderMetadata = {
              [providerOptionsName]: {},
              ...(reasoningOpaque ? { copilot: { reasoningOpaque } } : {}),
            }

            controller.enqueue({
              type: "finish",
              finishReason,
              usage,
              providerMetadata,
            })
          },
        }),
      ),
      request: { body },
      response: { headers: responseHeaders },
    }
  }
}

function prepareTools({
  tools,
  toolChoice,
}: {
  tools?: Array<LanguageModelV3FunctionTool | any>
  toolChoice?: LanguageModelV3CallOptions["toolChoice"]
}) {
  tools = tools?.length ? tools : undefined
  const toolWarnings: Array<SharedV3Warning> = []

  if (tools == null) {
    return { tools: undefined, toolChoice: undefined, toolWarnings }
  }

  const openaiTools: Array<{
    type: "function"
    function: { name: string; description: string | undefined; parameters: unknown }
  }> = []

  for (const tool of tools) {
    if (tool.type === "provider-defined") {
      toolWarnings.push({ type: "unsupported", feature: `tool: ${tool.id}` })
    } else {
      openaiTools.push({
        type: "function",
        function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
      })
    }
  }

  if (toolChoice == null) {
    return { tools: openaiTools, toolChoice: undefined, toolWarnings }
  }

  const type = toolChoice.type

  switch (type) {
    case "auto":
    case "none":
    case "required":
      return { tools: openaiTools, toolChoice: type, toolWarnings }
    case "tool":
      return {
        tools: openaiTools,
        toolChoice: { type: "function", function: { name: toolChoice.toolName } },
        toolWarnings,
      }
    default:
      throw new Error(`Unsupported tool choice type: ${(toolChoice as any).type}`)
  }
}

const copilotTokenUsageSchema = z
  .object({
    prompt_tokens: z.number().nullish(),
    completion_tokens: z.number().nullish(),
    total_tokens: z.number().nullish(),
    prompt_tokens_details: z.object({ cached_tokens: z.number().nullish() }).nullish(),
    completion_tokens_details: z
      .object({
        reasoning_tokens: z.number().nullish(),
        accepted_prediction_tokens: z.number().nullish(),
        rejected_prediction_tokens: z.number().nullish(),
      })
      .nullish(),
  })
  .nullish()

const CopilotChatResponseSchema = z.object({
  id: z.string().nullish(),
  created: z.number().nullish(),
  model: z.string().nullish(),
  choices: z.array(
    z.object({
      message: z.object({
        role: z.literal("assistant").nullish(),
        content: z.string().nullish(),
        reasoning_text: z.string().nullish(),
        reasoning_opaque: z.string().nullish(),
        tool_calls: z
          .array(z.object({ id: z.string().nullish(), function: z.object({ name: z.string(), arguments: z.string() }) }))
          .nullish(),
      }),
      finish_reason: z.string().nullish(),
    }),
  ),
  usage: copilotTokenUsageSchema,
})

const createCopilotChatChunkSchema = <ERROR_SCHEMA extends z.ZodTypeAny>(errorSchema: ERROR_SCHEMA) =>
  z.union([
    z.object({
      id: z.string().nullish(),
      created: z.number().nullish(),
      model: z.string().nullish(),
      choices: z.array(
        z.object({
          delta: z
            .object({
              role: z.enum(["assistant"]).nullish(),
              content: z.string().nullish(),
              reasoning_text: z.string().nullish(),
              reasoning_opaque: z.string().nullish(),
              tool_calls: z
                .array(
                  z.object({
                    index: z.number(),
                    id: z.string().nullish(),
                    function: z.object({ name: z.string().nullish(), arguments: z.string().nullish() }),
                  }),
                )
                .nullish(),
            })
            .nullish(),
          finish_reason: z.string().nullish(),
        }),
      ),
      usage: copilotTokenUsageSchema,
    }),
    errorSchema,
  ])
