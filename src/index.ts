// Provider exports

// Auth exports
export {
	type CopilotAuthConfig,
	type CopilotAuthResult,
	type CopilotTokenInfo,
	clearAllCachedTokens,
	clearCachedToken,
	completeOAuthFlow,
	createCopilotFetch,
	type DeviceCodeResponse,
	detectRequestType,
	getApiBaseUrl,
	getCachedToken,
	getCopilotHeaders,
	getOrCreateToken,
	initiateDeviceCodeAuth,
	needsRefresh,
	pollForAccessToken,
	saveToken,
	type TokenCache,
} from "./auth";
export type { CopilotProvider, CopilotProviderSettings } from "./copilot-provider";
export { copilot, createCopilot } from "./copilot-provider";
