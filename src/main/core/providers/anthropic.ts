import type { ApiProviderConfig } from '../../../shared/types'
import {
  ApiProviderError,
  defaultHttp,
  requireApiKey,
  type ApiCallOptions,
  type ApiProvider,
  type ChatTurn,
  type HttpClient,
} from './types'

const ENDPOINT = 'https://api.anthropic.com/v1/messages'
const API_VERSION = '2023-06-01'

interface AnthropicResponse {
  content?: Array<{ type: string; text?: string }>
}

/** Anthropic Messages API provider. */
export function createAnthropicProvider(config: ApiProviderConfig, http: HttpClient = defaultHttp): ApiProvider {
  return {
    id: config.id,
    provider: 'anthropic',
    model: config.model,
    async chat(messages: ChatTurn[], opts: ApiCallOptions = {}): Promise<string> {
      const apiKey = requireApiKey(config)
      const system = messages
        .filter((m) => m.role === 'system')
        .map((m) => m.content)
        .join('\n\n')
      const turns = messages
        .filter((m) => m.role !== 'system')
        .map((m) => ({ role: m.role, content: m.content }))

      const temperature = opts.temperature ?? config.temperature
      const body: Record<string, unknown> = {
        model: config.model,
        max_tokens: opts.maxTokens ?? config.maxTokens ?? 1024,
        messages: turns,
      }
      if (system) body.system = system
      if (temperature !== undefined) body.temperature = temperature

      const res = await http(ENDPOINT, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': API_VERSION,
        },
        body: JSON.stringify(body),
        signal: opts.signal,
      })

      const text = await res.text()
      if (!res.ok) throw new ApiProviderError('anthropic', res.status, text)

      const parsed = JSON.parse(text) as AnthropicResponse
      return (parsed.content ?? [])
        .filter((c) => c.type === 'text' && typeof c.text === 'string')
        .map((c) => c.text)
        .join('')
    },
  }
}
