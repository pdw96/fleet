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

const ENDPOINT = 'https://api.openai.com/v1/chat/completions'

interface OpenAiResponse {
  choices?: Array<{ message?: { content?: string } }>
}

/** OpenAI Chat Completions API provider. */
export function createOpenAiProvider(config: ApiProviderConfig, http: HttpClient = defaultHttp): ApiProvider {
  return {
    id: config.id,
    provider: 'openai',
    model: config.model,
    async chat(messages: ChatTurn[], opts: ApiCallOptions = {}): Promise<string> {
      const apiKey = requireApiKey(config)
      const temperature = opts.temperature ?? config.temperature

      const body: Record<string, unknown> = {
        model: config.model,
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
      }
      const maxTokens = opts.maxTokens ?? config.maxTokens
      if (maxTokens !== undefined) body.max_tokens = maxTokens
      if (temperature !== undefined) body.temperature = temperature

      const res = await http(ENDPOINT, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: opts.signal,
      })

      const text = await res.text()
      if (!res.ok) throw new ApiProviderError('openai', res.status, text)

      const parsed = JSON.parse(text) as OpenAiResponse
      return parsed.choices?.[0]?.message?.content ?? ''
    },
  }
}
