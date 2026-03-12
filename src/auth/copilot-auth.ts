import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const CLIENT_ID = "Ov23li8tweQw6odWQebz"; // Opencode OAuth client ID
const OAUTH_POLLING_SAFETY_MARGIN_MS = 3000; // 3 seconds

// Token cache directory
const TOKEN_CACHE_DIR = path.join(os.homedir(), ".copilot-provider");
const TOKEN_CACHE_FILE = path.join(TOKEN_CACHE_DIR, "token-cache.json");

export interface CopilotAuthConfig {
	/**
	 * Enterprise URL for GitHub Enterprise deployments.
	 * Can be a full URL or just the domain (e.g., "company.ghe.com")
	 */
	enterpriseUrl?: string;

	/**
	 * Enable token persistence to disk.
	 * When true, tokens will be cached and reused across sessions.
	 * @default true
	 */
	persistToken?: boolean;

	/**
	 * Custom token cache directory.
	 * Defaults to ~/.copilot-provider
	 */
	tokenCacheDir?: string;

	/**
	 * Token refresh threshold in seconds.
	 * If the token is older than this, it will be refreshed.
	 * @default 3600 (1 hour)
	 */
	refreshThresholdSeconds?: number;
}

export interface CopilotAuthResult {
	type: "success";
	accessToken: string;
	refreshToken: string;
	expiresAt: number;
	enterpriseUrl?: string;
}

export interface CopilotTokenInfo {
	accessToken: string;
	refreshToken: string;
	expiresAt: number;
	enterpriseUrl?: string;
	createdAt: number;
	lastUsedAt: number;
}

export interface DeviceCodeResponse {
	verificationUri: string;
	userCode: string;
	deviceCode: string;
	interval: number;
}

export interface TokenCache {
	version: number;
	tokens: Record<string, CopilotTokenInfo>;
}

function normalizeDomain(url: string): string {
	return url.replace(/^https?:\/\//, "").replace(/\/$/, "");
}

function getOAuthUrls(domain: string) {
	return {
		deviceCodeUrl: `https://${domain}/login/device/code`,
		accessTokenUrl: `https://${domain}/login/oauth/access_token`,
	};
}

function getApiBaseUrl(enterpriseUrl?: string): string {
	if (enterpriseUrl) {
		const domain = normalizeDomain(enterpriseUrl);
		return `https://copilot-api.${domain}`;
	}
	return "https://api.githubcopilot.com";
}

/**
 * Get the cache key for a given configuration
 */
function getCacheKey(enterpriseUrl?: string): string {
	return enterpriseUrl ? `enterprise:${normalizeDomain(enterpriseUrl)}` : "github.com";
}

/**
 * Ensure the token cache directory exists
 */
function ensureCacheDir(cacheDir?: string): string {
	const dir = cacheDir ?? TOKEN_CACHE_DIR;
	if (!fs.existsSync(dir)) {
		fs.mkdirSync(dir, { recursive: true });
	}
	return dir;
}

/**
 * Read the token cache from disk
 */
function readTokenCache(cacheDir?: string): TokenCache {
	const cacheFile = cacheDir ? path.join(cacheDir, "token-cache.json") : TOKEN_CACHE_FILE;

	try {
		if (!fs.existsSync(cacheFile)) {
			return { version: 1, tokens: {} };
		}

		const content = fs.readFileSync(cacheFile, "utf-8");
		const cache = JSON.parse(content) as TokenCache;

		// Migrate old cache format if needed
		if (!cache.version) {
			return { version: 1, tokens: {} };
		}

		return cache;
	} catch {
		return { version: 1, tokens: {} };
	}
}

/**
 * Write the token cache to disk
 */
function writeTokenCache(cache: TokenCache, cacheDir?: string): void {
	const dir = ensureCacheDir(cacheDir);
	const cacheFile = path.join(dir, "token-cache.json");

	fs.writeFileSync(cacheFile, JSON.stringify(cache, null, 2), { mode: 0o600 });
}

/**
 * Get a cached token if it exists and is valid
 */
export function getCachedToken(config?: CopilotAuthConfig): CopilotTokenInfo | null {
	const { persistToken = true, tokenCacheDir } = config ?? {};

	if (!persistToken) {
		return null;
	}

	const cache = readTokenCache(tokenCacheDir);
	const key = getCacheKey(config?.enterpriseUrl);
	const token = cache.tokens[key];

	if (!token) {
		return null;
	}

	// Update last used time
	token.lastUsedAt = Date.now();
	cache.tokens[key] = token;
	writeTokenCache(cache, tokenCacheDir);

	return token;
}

/**
 * Save a token to the cache
 */
export function saveToken(token: CopilotAuthResult, config?: CopilotAuthConfig): void {
	const { persistToken = true, tokenCacheDir } = config ?? {};

	if (!persistToken) {
		return;
	}

	const cache = readTokenCache(tokenCacheDir);
	const key = getCacheKey(config?.enterpriseUrl ?? token.enterpriseUrl);

	cache.tokens[key] = {
		accessToken: token.accessToken,
		refreshToken: token.refreshToken,
		expiresAt: token.expiresAt,
		enterpriseUrl: token.enterpriseUrl,
		createdAt: Date.now(),
		lastUsedAt: Date.now(),
	};

	writeTokenCache(cache, tokenCacheDir);
}

/**
 * Clear a cached token
 */
export function clearCachedToken(config?: CopilotAuthConfig): void {
	const { tokenCacheDir } = config ?? {};
	const cache = readTokenCache(tokenCacheDir);
	const key = getCacheKey(config?.enterpriseUrl);

	delete cache.tokens[key];
	writeTokenCache(cache, tokenCacheDir);
}

/**
 * Clear all cached tokens
 */
export function clearAllCachedTokens(cacheDir?: string): void {
	const dir = cacheDir ?? TOKEN_CACHE_DIR;
	const cacheFile = path.join(dir, "token-cache.json");

	if (fs.existsSync(cacheFile)) {
		fs.unlinkSync(cacheFile);
	}
}

/**
 * Check if a token needs refresh
 */
export function needsRefresh(token: CopilotTokenInfo, thresholdSeconds = 3600): boolean {
	const now = Date.now();
	const tokenAge = (now - token.createdAt) / 1000;
	return tokenAge > thresholdSeconds;
}

/**
 * Initiate device code OAuth flow for GitHub Copilot
 */
export async function initiateDeviceCodeAuth(
	enterpriseUrl?: string
): Promise<DeviceCodeResponse & { enterpriseUrl?: string }> {
	const domain = enterpriseUrl ? normalizeDomain(enterpriseUrl) : "github.com";
	const urls = getOAuthUrls(domain);

	const response = await fetch(urls.deviceCodeUrl, {
		method: "POST",
		headers: {
			Accept: "application/json",
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			client_id: CLIENT_ID,
			scope: "read:user",
		}),
	});

	if (!response.ok) {
		throw new Error("Failed to initiate device authorization");
	}

	const data = (await response.json()) as {
		verification_uri: string;
		user_code: string;
		device_code: string;
		interval: number;
	};

	return {
		verificationUri: data.verification_uri,
		userCode: data.user_code,
		deviceCode: data.device_code,
		interval: data.interval,
		enterpriseUrl: enterpriseUrl,
	};
}

/**
 * Poll for access token after user completes device code auth
 */
export async function pollForAccessToken(
	deviceCode: string,
	interval: number,
	enterpriseUrl?: string,
	onStatusChange?: (status: "pending" | "success" | "error", message?: string) => void
): Promise<CopilotAuthResult> {
	const domain = enterpriseUrl ? normalizeDomain(enterpriseUrl) : "github.com";
	const urls = getOAuthUrls(domain);

	let currentInterval = interval;

	while (true) {
		onStatusChange?.("pending", "Waiting for authorization...");

		const response = await fetch(urls.accessTokenUrl, {
			method: "POST",
			headers: {
				Accept: "application/json",
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				client_id: CLIENT_ID,
				device_code: deviceCode,
				grant_type: "urn:ietf:params:oauth:grant-type:device_code",
			}),
		});

		if (!response.ok) {
			onStatusChange?.("error", "Failed to check authorization status");
			throw new Error("Failed to check authorization status");
		}

		const data = (await response.json()) as {
			access_token?: string;
			error?: string;
			interval?: number;
		};

		if (data.access_token) {
			onStatusChange?.("success", "Authorization successful!");
			return {
				type: "success",
				accessToken: data.access_token,
				refreshToken: data.access_token,
				expiresAt: 0, // GitHub Copilot tokens don't expire in the traditional sense
				enterpriseUrl: enterpriseUrl,
			};
		}

		if (data.error === "authorization_pending") {
			await sleep(currentInterval * 1000 + OAUTH_POLLING_SAFETY_MARGIN_MS);
			continue;
		}

		if (data.error === "slow_down") {
			// Add 5 seconds to current interval per RFC spec
			let newInterval = (currentInterval + 5) * 1000;

			// Use server-provided interval if available
			if (data.interval && typeof data.interval === "number" && data.interval > 0) {
				newInterval = data.interval * 1000;
			}

			currentInterval = newInterval / 1000;
			await sleep(newInterval + OAUTH_POLLING_SAFETY_MARGIN_MS);
			continue;
		}

		if (data.error) {
			onStatusChange?.("error", `Authorization failed: ${data.error}`);
			throw new Error(`Authorization failed: ${data.error}`);
		}

		await sleep(currentInterval * 1000 + OAUTH_POLLING_SAFETY_MARGIN_MS);
	}
}

/**
 * Get or create a token - returns cached token if valid, otherwise starts OAuth flow
 */
export async function getOrCreateToken(
	config?: CopilotAuthConfig,
	onStatusChange?: (status: "pending" | "success" | "error" | "cached", message?: string) => void
): Promise<CopilotAuthResult> {
	const { persistToken = true, refreshThresholdSeconds = 3600 } = config ?? {};

	// Try to get cached token
	const cachedToken = getCachedToken(config);

	if (cachedToken) {
		// Check if token needs refresh
		if (needsRefresh(cachedToken, refreshThresholdSeconds)) {
			onStatusChange?.("pending", "Token needs refresh, starting OAuth flow...");
		} else {
			onStatusChange?.("cached", "Using cached token");
			return {
				type: "success",
				accessToken: cachedToken.accessToken,
				refreshToken: cachedToken.refreshToken,
				expiresAt: cachedToken.expiresAt,
				enterpriseUrl: cachedToken.enterpriseUrl,
			};
		}
	}

	// Start OAuth flow
	const authResult = await completeOAuthFlow(config, onStatusChange);

	// Save token if persistence is enabled
	if (persistToken) {
		saveToken(authResult, config);
	}

	return authResult;
}

/**
 * Complete OAuth flow - initiates device code and waits for completion
 */
export async function completeOAuthFlow(
	config?: CopilotAuthConfig,
	onStatusChange?: (status: "pending" | "success" | "error", message?: string) => void
): Promise<CopilotAuthResult> {
	const deviceCode = await initiateDeviceCodeAuth(config?.enterpriseUrl);

	console.log(`\nPlease visit: ${deviceCode.verificationUri}`);
	console.log(`And enter code: ${deviceCode.userCode}\n`);

	onStatusChange?.(
		"pending",
		`Visit ${deviceCode.verificationUri} and enter code: ${deviceCode.userCode}`
	);

	const result = await pollForAccessToken(
		deviceCode.deviceCode,
		deviceCode.interval,
		deviceCode.enterpriseUrl,
		onStatusChange
	);

	// Save token if persistence is enabled
	if (config?.persistToken !== false) {
		saveToken(result, config);
	}

	return result;
}

/**
 * Get headers for Copilot API requests
 */
export function getCopilotHeaders(options: {
	accessToken: string;
	isAgent?: boolean;
	isVision?: boolean;
}): Record<string, string> {
	const { accessToken, isAgent = false, isVision = false } = options;

	const headers: Record<string, string> = {
		Authorization: `Bearer ${accessToken}`,
		"Openai-Intent": "conversation-edits",
		"x-initiator": isAgent ? "agent" : "user",
	};

	if (isVision) {
		headers["Copilot-Vision-Request"] = "true";
	}

	return headers;
}

/**
 * Detect request type from request body
 */
export function detectRequestType(
	url: string,
	body: unknown
): { isVision: boolean; isAgent: boolean } {
	try {
		if (!body || typeof body !== "object") {
			return { isVision: false, isAgent: false };
		}

		const requestBody = body as Record<string, unknown>;

		// Completions API
		if (requestBody.messages && url.includes("completions")) {
			const messages = requestBody.messages as Array<Record<string, unknown>>;
			const last = messages[messages.length - 1];

			return {
				isVision: messages.some(
					(msg: Record<string, unknown>) =>
						Array.isArray(msg.content) &&
						msg.content.some((part: Record<string, unknown>) => part.type === "image_url")
				),
				isAgent: last?.role !== "user",
			};
		}

		// Responses API
		if (requestBody.input) {
			const input = requestBody.input as Array<Record<string, unknown>>;
			const last = input[input.length - 1];

			return {
				isVision: input.some(
					(item: Record<string, unknown>) =>
						Array.isArray(item?.content) &&
						item.content.some((part: Record<string, unknown>) => part.type === "input_image")
				),
				isAgent: last?.role !== "user",
			};
		}

		// Messages API (Anthropic style)
		if (requestBody.messages) {
			const messages = requestBody.messages as Array<Record<string, unknown>>;
			const last = messages[messages.length - 1];
			const hasNonToolCalls =
				Array.isArray(last?.content) &&
				last.content.some((part: Record<string, unknown>) => part?.type !== "tool_result");

			return {
				isVision: messages.some(
					(item: Record<string, unknown>) =>
						Array.isArray(item?.content) &&
						item.content.some(
							(part: Record<string, unknown>) =>
								part?.type === "image" ||
								(part?.type === "tool_result" &&
									Array.isArray(part.content) &&
									part.content.some((nested: Record<string, unknown>) => nested?.type === "image"))
						)
				),
				isAgent: !(last?.role === "user" && hasNonToolCalls),
			};
		}
	} catch {
		// Ignore parsing errors
	}

	return { isVision: false, isAgent: false };
}

/**
 * Create an authenticated fetch function for Copilot API
 */
export function createCopilotFetch(
	getToken: () => Promise<string> | string,
	options?: {
		enterpriseUrl?: string;
		onRequest?: (request: string | URL, init?: RequestInit) => void;
		onResponse?: (response: Response) => void;
	}
): (request: string | URL, init?: RequestInit) => Promise<Response> {
	return async (request: string | URL, init?: RequestInit) => {
		const token = await getToken();
		const url = request instanceof URL ? request.href : request.toString();

		// Parse request body to detect request type
		let body: unknown;
		if (init?.body) {
			try {
				body = typeof init.body === "string" ? JSON.parse(init.body) : init.body;
			} catch {
				// Ignore parsing errors
			}
		}

		const { isVision, isAgent } = detectRequestType(url, body);

		// Build headers
		const originalHeaders = (init?.headers as Record<string, string>) || {};
		const copilotHeaders = getCopilotHeaders({
			accessToken: token,
			isAgent,
			isVision,
		});

		// Remove conflicting headers
		const cleanHeaders = { ...originalHeaders };
		delete cleanHeaders["x-api-key"];
		delete cleanHeaders["authorization"];
		delete cleanHeaders["Authorization"];

		const finalHeaders = {
			...cleanHeaders,
			...copilotHeaders,
		};

		options?.onRequest?.(request, init);

		const response = await fetch(request, {
			...init,
			headers: finalHeaders,
		});

		options?.onResponse?.(response);

		return response;
	};
}

export { getApiBaseUrl };
