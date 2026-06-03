import type { ApiProviderConfig } from '../../../shared/types'
import { createAnthropicProvider } from './anthropic'
import { createGoogleProvider } from './google'
import { createOpenAiProvider } from './openai'
import { defaultHttp, type ApiProvider, type HttpClient } from './types'

/**
 * 설정으로부터 API provider 인스턴스 생성. 새 provider 는 여기 한 곳에서 분기 추가.
 * (요구사항 9: 새로운 API provider 를 쉽게 추가)
 */
export function createApiProvider(config: ApiProviderConfig, http: HttpClient = defaultHttp): ApiProvider {
  switch (config.provider) {
    case 'anthropic':
      return createAnthropicProvider(config, http)
    case 'openai':
      return createOpenAiProvider(config, http)
    case 'google':
      return createGoogleProvider(config, http)
    default: {
      const exhaustive: never = config.provider
      throw new Error(`지원하지 않는 provider: ${String(exhaustive)}`)
    }
  }
}
