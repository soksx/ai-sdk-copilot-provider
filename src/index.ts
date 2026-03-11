// Provider exports
export { createCopilot, copilot } from "./copilot-provider"
export type { CopilotProvider, CopilotProviderSettings } from "./copilot-provider"

// Auth exports
export {
  initiateDeviceCodeAuth,
  pollForAccessToken,
  completeOAuthFlow,
  getOrCreateToken,
  getCachedToken,
  saveToken,
  clearCachedToken,
  clearAllCachedTokens,
  needsRefresh,
  getCopilotHeaders,
  detectRequestType,
  createCopilotFetch,
  getApiBaseUrl,
  type CopilotAuthConfig,
  type CopilotAuthResult,
  type CopilotTokenInfo,
  type DeviceCodeResponse,
  type TokenCache,
} from "./auth"
