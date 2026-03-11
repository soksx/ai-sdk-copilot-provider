# @soksx/ai-sdk-copilot-provider

GitHub Copilot provider for the AI SDK. This package allows you to use GitHub Copilot models with the AI SDK framework.

## Installation

```bash
npm install @soksx/ai-sdk-copilot-provider
# or
pnpm add @soksx/ai-sdk-copilot-provider
# or
yarn add @soksx/ai-sdk-copilot-provider
```

## Usage

### Basic Usage

```typescript
import { copilot } from '@soksx/ai-sdk-copilot-provider';
import { Agent } from "@mastra/core/agent";

const agent = new Agent({
  id: "my-agent",
  name: "My Agent",
  instructions: "You are a helpful assistant.",
  model: copilot('gpt-5-mini')
});
```

### With OAuth Authentication

The package includes a complete OAuth flow for GitHub Copilot authentication:

```typescript
import { createCopilot, completeOAuthFlow } from '@soksx/ai-sdk-copilot-provider';
import { Agent } from "@mastra/core/agent";

// Complete the OAuth flow
const authResult = await completeOAuthFlow({
  // Optional: For GitHub Enterprise
  // enterpriseUrl: "company.ghe.com"
}, (status, message) => {
  console.log(`${status}: ${message}`);
});

// Create provider with dynamic token
const copilot = createCopilot({
  getToken: () => authResult.accessToken,
  enterpriseUrl: authResult.enterpriseUrl
});

const agent = new Agent({
  id: "my-agent",
  name: "My Agent",
  instructions: "You are a helpful assistant.",
  model: copilot('gpt-4o')
});
```

### GitHub Enterprise

For GitHub Enterprise deployments:

```typescript
import { createCopilot } from '@soksx/ai-sdk-copilot-provider';

const copilot = createCopilot({
  apiKey: process.env.GITHUB_TOKEN,
  enterpriseUrl: 'company.ghe.com' // or 'https://company.ghe.com'
});
```

### Using Different Model Types

```typescript
import { copilot } from '@soksx/ai-sdk-copilot-provider';

// Chat completions (default)
const chatModel = copilot('gpt-4o');

// Explicitly use chat
const chatModelExplicit = copilot.chat('gpt-4o');

// Use responses API (for reasoning models)
const responsesModel = copilot.responses('o3-mini');
```

### Custom Fetch with Request Logging

```typescript
import { createCopilot, createCopilotFetch } from '@soksx/ai-sdk-copilot-provider';

const authenticatedFetch = createCopilotFetch(
  () => process.env.GITHUB_TOKEN!,
  {
    onRequest: (request, init) => {
      console.log(`Request to: ${request}`);
    },
    onResponse: (response) => {
      console.log(`Response status: ${response.status}`);
    }
  }
);

const copilot = createCopilot({
  fetch: authenticatedFetch
});
```

## Configuration Options

### `CopilotProviderSettings`

| Option | Type | Description |
|--------|------|-------------|
| `apiKey` | `string` | API key for authentication. Falls back to `GITHUB_TOKEN` or `COPILOT_TOKEN` environment variables. |
| `baseURL` | `string` | Base URL for the Copilot API. Defaults to GitHub Copilot's API endpoint. |
| `headers` | `Record<string, string>` | Custom headers to include in requests. |
| `fetch` | `FetchFunction` | Custom fetch implementation. |
| `getToken` | `() => string \| Promise<string>` | Dynamic token function for OAuth flow. |
| `autoDetectRequestType` | `boolean` | Auto-detect agent vs user requests and vision requests. Default: `true` |
| `enterpriseUrl` | `string` | GitHub Enterprise URL or domain. |

## Authentication

The package supports multiple authentication methods:

### 1. Static API Key

```typescript
import { createCopilot } from '@soksx/ai-sdk-copilot-provider';

const copilot = createCopilot({
  apiKey: process.env.GITHUB_TOKEN
});
```

### 2. Environment Variables

Set `GITHUB_TOKEN` or `COPILOT_TOKEN` in your environment.

### 3. OAuth Flow with Token Persistence (Recommended)

The package automatically caches tokens to disk, so you only need to authenticate once:

```typescript
import { getOrCreateToken, createCopilot } from '@soksx/ai-sdk-copilot-provider';

// Get cached token or start OAuth flow if needed
const auth = await getOrCreateToken({
  persistToken: true, // default: true
  refreshThresholdSeconds: 3600, // refresh after 1 hour (default)
}, (status, message) => {
  console.log(`${status}: ${message}`);
});

// Create provider with token
const copilot = createCopilot({
  getToken: () => auth.accessToken
});
```

### 4. Manual OAuth Flow

```typescript
import { completeOAuthFlow, createCopilot } from '@soksx/ai-sdk-copilot-provider';

// Step 1: Initiate OAuth flow (token will be cached automatically)
const auth = await completeOAuthFlow();

// Step 2: Create provider with token
const copilot = createCopilot({
  getToken: () => auth.accessToken
});
```

### 5. Token Management

```typescript
import {
  getCachedToken,
  saveToken,
  clearCachedToken,
  clearAllCachedTokens,
  needsRefresh
} from '@soksx/ai-sdk-copilot-provider';

// Get cached token without starting OAuth
const cached = getCachedToken();
if (cached) {
  console.log('Token created at:', new Date(cached.createdAt));
  console.log('Needs refresh:', needsRefresh(cached, 3600));
}

// Clear a specific token
clearCachedToken({ enterpriseUrl: 'company.ghe.com' });

// Clear all cached tokens
clearAllCachedTokens();
```

### 6. Dynamic Token (for custom refresh logic)

```typescript
import { createCopilot, getCachedToken, completeOAuthFlow } from '@soksx/ai-sdk-copilot-provider';

const copilot = createCopilot({
  getToken: async () => {
    const cached = getCachedToken();
    if (cached && !needsRefresh(cached, 3600)) {
      return cached.accessToken;
    }
    const auth = await completeOAuthFlow();
    return auth.accessToken;
  }
});
```

## Automatic Request Headers

The provider automatically adds the correct Copilot headers:

- `x-initiator`: Set to `"agent"` for sub-agent requests, `"user"` for direct user requests
- `Copilot-Vision-Request`: Set to `"true"` for requests containing images
- `Openai-Intent`: Set to `"conversation-edits"`

## Supported Models

This provider supports GitHub Copilot models including:

- `gpt-4o` - GPT-4 optimized
- `gpt-4o-mini` - GPT-4 Mini
- `gpt-5` - GPT-5 (reasoning model)
- `gpt-5-mini` - GPT-5 Mini (reasoning model)
- `gpt-5-nano` - GPT-5 Nano (reasoning model)
- `o1-mini` - o1 Mini (reasoning model)
- `o1-preview` - o1 Preview (reasoning model)
- `o3-mini` - o3 Mini (reasoning model)
- `o4-mini` - o4 Mini (reasoning model)

## Features

- Full support for chat completions API
- Support for responses API (for reasoning models)
- Streaming support
- Tool calling
- Multi-turn reasoning with `reasoning_opaque` support
- Automatic request type detection (agent vs user)
- Vision request detection
- OAuth device code flow with **automatic token persistence**
- Token caching and reuse across sessions
- Configurable token refresh threshold
- GitHub Enterprise support
- TypeScript support

## Environment Variables

- `GITHUB_TOKEN` - Your GitHub token for Copilot authentication
- `COPILOT_TOKEN` - Alternative token for Copilot authentication
- `COPILOT_BASE_URL` - Custom base URL for the Copilot API

## API Reference

### `createCopilot(options?)`

Creates a new Copilot provider instance.

### `copilot`

Default Copilot provider instance.

### `getOrCreateToken(config?, onStatusChange?)`

**Recommended**: Gets a cached token if valid, otherwise starts OAuth flow. Handles token persistence automatically.

### `completeOAuthFlow(config?, onStatusChange?)`

Initiates and completes the OAuth device code flow. Token is automatically cached.

### `getCachedToken(config?)`

Returns the cached token if it exists, or null.

### `saveToken(token, config?)`

Manually save a token to the cache.

### `clearCachedToken(config?)`

Clear a specific cached token.

### `clearAllCachedTokens(cacheDir?)`

Clear all cached tokens.

### `needsRefresh(token, thresholdSeconds?)`

Check if a token needs refresh based on its age.

### `initiateDeviceCodeAuth(enterpriseUrl?)`

Starts the device code OAuth flow, returns the verification URL and code.

### `pollForAccessToken(deviceCode, interval, enterpriseUrl?, onStatusChange?)`

Polls for the access token after user completes authorization.

### `getCopilotHeaders(options)`

Returns the required headers for Copilot API requests.

### `detectRequestType(url, body)`

Detects if a request is a vision or agent request.

### `createCopilotFetch(getToken, options?)`

Creates an authenticated fetch function with automatic header injection.

### `getApiBaseUrl(enterpriseUrl?)`

Returns the appropriate API base URL for the deployment type.

## License

MIT
