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

const BASE = 'https://generativelanguage.googleapis.com/v1beta/models'

interface GoogleResponse {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>
}

/** Google Gemini generateContent API provider. */
export function createGoogleProvider(config: ApiProviderConfig, http: HttpClient = defaultHttp): ApiProvider {
  return {
    id: config.id,
    provider: 'google',
    model: config.model,
    async chat(messages: ChatTurn[], opts: ApiCallOptions = {}): Promise<string> {
      const apiKey = requireApiKey(config)
      const temperature = opts.temperature ?? config.temperature
      const maxTokens = opts.maxTokens ?? config.maxTokens

      const systemText = messages
        .filter((m) => m.role === 'system')
        .map((m) => m.content)
        .join('\n\n')
      const contents = messages
        .filter((m) => m.role !== 'system')
        .map((m) => ({
          role: m.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: m.content }],
        }))

      const generationConfig: Record<string, unknown> = {}
      if (temperature !== undefined) generationConfig.temperature = temperature
      if (maxTokens !== undefined) generationConfig.maxOutputTokens = maxTokens

      const body: Record<string, unknown> = { contents }
      if (systemText) body.systemInstruction = { parts: [{ text: systemText }] }
      if (Object.keys(generationConfig).length > 0) body.generationConfig = generationConfig

      const url = `${BASE}/${encodeURIComponent(config.model)}:generateContent?key=${encodeURIComponent(apiKey)}`
      const res = await http(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: opts.signal,
      })

      const text = await res.text()
      if (!res.ok) throw new ApiProviderError('google', res.status, text)

      const parsed = JSON.parse(text) as GoogleResponse
      return (parsed.candidates?.[0]?.content?.parts ?? [])
        .map((p) => p.text ?? '')
        .join('')
    },
  }
}
