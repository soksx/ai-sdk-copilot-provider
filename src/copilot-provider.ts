import type { LanguageModelV3 } from "@ai-sdk/provider"
import { type FetchFunction, withoutTrailingSlash } from "@ai-sdk/provider-utils"
import { CopilotChatLanguageModel } from "./chat/copilot-chat-language-model"
import { CopilotResponsesLanguageModel } from "./responses/copilot-responses-language-model"
import { getApiBaseUrl, getCopilotHeaders, type CopilotAuthConfig } from "./auth"

// Type for the fetch wrapper function
type FetchWrapper = (url: string | URL, options?: RequestInit) => Promise<Response>

export type CopilotModelId = string

export interface CopilotProviderSettings extends CopilotAuthConfig {
  /**
   * API key for authenticating requests.
   * If not provided, will attempt to use GITHUB_TOKEN or COPILOT_TOKEN environment variable.
   * For OAuth flow, use the auth module instead.
   */
  apiKey?: string

  /**
   * Base URL for the Copilot API calls.
   * Defaults to GitHub Copilot's API endpoint.
   * For enterprise deployments, this will be auto-configured from enterpriseUrl.
   */
  baseURL?: string

  /**
   * Custom headers to include in the requests.
   */
  headers?: Record<string, string>

  /**
   * Custom fetch implementation.
   * If not provided, will use the authenticated fetch with Copilot headers.
   */
  fetch?: FetchFunction

  /**
   * Token refresh function for OAuth flow.
   * Called before each request to get the current access token.
   */
  getToken?: () => Promise<string> | string

  /**
   * Enable automatic request type detection for proper headers.
   * When true, will automatically detect agent vs user requests and vision requests.
   * @default true
   */
  autoDetectRequestType?: boolean
}

export interface CopilotProvider {
  (modelId: CopilotModelId): LanguageModelV3
  chat(modelId: CopilotModelId): LanguageModelV3
  responses(modelId: CopilotModelId): LanguageModelV3
  languageModel(modelId: CopilotModelId): LanguageModelV3
}

/**
 * Create a GitHub Copilot provider instance.
 *
 * Supports multiple authentication methods:
 * 1. Static API key via `apiKey` option or GITHUB_TOKEN/COPILOT_TOKEN env vars
 * 2. OAuth flow via the auth module (see `completeOAuthFlow`)
 * 3. Dynamic token via `getToken` function
 *
 * For GitHub Enterprise, set `enterpriseUrl` to your enterprise domain.
 */
export function createCopilot(options: CopilotProviderSettings = {}): CopilotProvider {
  const {
    apiKey,
    enterpriseUrl,
    getToken,
    autoDetectRequestType = true,
    headers: customHeaders = {},
    fetch: customFetch,
  } = options

  // Determine base URL - prefer enterprise URL if provided
  const baseURL = withoutTrailingSlash(
    options.baseURL ?? process.env.COPILOT_BASE_URL ?? getApiBaseUrl(enterpriseUrl)
  )

  // Resolve API key from options, environment, or getToken function
  const resolveApiKey = (): string | undefined => {
    if (getToken) {
      // For sync access, if getToken returns a promise, we'll handle it in the fetch wrapper
      const result = getToken()
      if (typeof result === "string") return result
      return undefined // Will be resolved in fetch
    }
    return apiKey ?? process.env.GITHUB_TOKEN ?? process.env.COPILOT_TOKEN
  }

  // Synchronous headers for the model config
  const getHeaders = () => {
    const token = resolveApiKey()
    const baseHeaders: Record<string, string | undefined> = {
      ...(token && { Authorization: `Bearer ${token}` }),
      "Openai-Intent": "conversation-edits",
      ...customHeaders,
    }
    return baseHeaders
  }

  // Create authenticated fetch function
  const authenticatedFetch: FetchWrapper | undefined = (() => {
    if (customFetch) {
      return customFetch
    }

    // If we have a getToken function or auto-detect is enabled, create a wrapper
    if (getToken || autoDetectRequestType) {
      return async (input: string | URL, init?: RequestInit) => {
        // Resolve token (handle async getToken)
        let token: string | undefined
        if (getToken) {
          const result = getToken()
          token = result instanceof Promise ? await result : result
        } else {
          token = apiKey ?? process.env.GITHUB_TOKEN ?? process.env.COPILOT_TOKEN
        }

        // Parse body for request type detection
        let body: unknown = undefined
        if (init?.body) {
          try {
            body = typeof init.body === "string" ? JSON.parse(init.body) : init.body
          } catch {
            // Ignore parsing errors
          }
        }

        // Detect request type for proper headers
        const isAgent = detectAgentRequest(body)
        const isVision = detectVisionRequest(body)

        // Build headers with Copilot-specific ones
        const copilotHeaders = getCopilotHeaders({
          accessToken: token || "",
          isAgent,
          isVision,
        })

        // Merge with custom headers
        const originalHeaders = (init?.headers as Record<string, string>) || {}
        const cleanHeaders = { ...originalHeaders }
        delete cleanHeaders["x-api-key"]
        delete cleanHeaders["authorization"]
        delete cleanHeaders["Authorization"]

        const finalHeaders = {
          ...cleanHeaders,
          ...copilotHeaders,
          ...customHeaders,
        }

        return fetch(input, {
          ...init,
          headers: finalHeaders,
        })
      }
    }

    return undefined
  })()

  const createChatModel = (modelId: CopilotModelId) => {
    return new CopilotChatLanguageModel(modelId, {
      provider: "copilot.chat",
      headers: getHeaders,
      url: ({ path }) => `${baseURL}${path}`,
      fetch: authenticatedFetch as FetchFunction,
    })
  }

  const createResponsesModel = (modelId: CopilotModelId) => {
    return new CopilotResponsesLanguageModel(modelId, {
      provider: "copilot.responses",
      headers: getHeaders,
      url: ({ path }) => `${baseURL}${path}`,
      fetch: authenticatedFetch as FetchFunction,
    })
  }

  const createLanguageModel = (modelId: CopilotModelId) => createChatModel(modelId)

  const provider = function (modelId: CopilotModelId) {
    return createChatModel(modelId)
  }

  provider.languageModel = createLanguageModel
  provider.chat = createChatModel
  provider.responses = createResponsesModel

  return provider as CopilotProvider
}

/**
 * Detect if this is an agent-initiated request
 */
function detectAgentRequest(body: unknown): boolean {
  if (!body || typeof body !== "object") return false

  const requestBody = body as Record<string, unknown>

  // Completions API - check if last message is not from user
  if (requestBody.messages && Array.isArray(requestBody.messages)) {
    const messages = requestBody.messages
    const last = messages[messages.length - 1]
    return last?.role !== "user"
  }

  // Responses API - check if last input is not from user
  if (requestBody.input && Array.isArray(requestBody.input)) {
    const input = requestBody.input
    const last = input[input.length - 1]
    return last?.role !== "user"
  }

  return false
}

/**
 * Detect if this is a vision request (contains images)
 */
function detectVisionRequest(body: unknown): boolean {
  if (!body || typeof body !== "object") return false

  const requestBody = body as Record<string, unknown>

  // Completions API
  if (requestBody.messages && Array.isArray(requestBody.messages)) {
    return requestBody.messages.some(
      (msg: Record<string, unknown>) =>
        Array.isArray(msg.content) &&
        msg.content.some((part: Record<string, unknown>) => part.type === "image_url"),
    )
  }

  // Responses API
  if (requestBody.input && Array.isArray(requestBody.input)) {
    return requestBody.input.some(
      (item: Record<string, unknown>) =>
        Array.isArray(item?.content) &&
        item.content.some((part: Record<string, unknown>) => part.type === "input_image"),
    )
  }

  // Messages API (Anthropic style)
  if (requestBody.messages && Array.isArray(requestBody.messages)) {
    return requestBody.messages.some(
      (item: Record<string, unknown>) =>
        Array.isArray(item?.content) &&
        item.content.some(
          (part: Record<string, unknown>) =>
            part?.type === "image" ||
            (part?.type === "tool_result" &&
              Array.isArray(part.content) &&
              part.content.some((nested: Record<string, unknown>) => nested?.type === "image")),
        ),
    )
  }

  return false
}

// Default Copilot provider instance
export const copilot = createCopilot()
