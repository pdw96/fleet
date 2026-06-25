import type { ApiProviderConfig } from '../../shared/types'

export type RiskLevel = 'clean' | 'caution' | 'warning'
export interface AuthBanner {
  level: RiskLevel
  message: string
  recommendApi: boolean
  docsUrl?: string
}
type Provider = ApiProviderConfig['provider']

// 스펙 §5 — 법률 단정 금지, 정책 리스크 안내. null = 구독 분기 미제공.
export const SUBSCRIPTION_BANNERS: Record<Provider, AuthBanner | null> = {
  anthropic: {
    level: 'clean',
    recommendApi: false,
    message:
      '공식 Claude Code CLI 인증을 그대로 사용합니다. Fleet 은 Claude 자격증명을 저장/읽지 않습니다.',
  },
  openai: {
    level: 'caution',
    recommendApi: false,
    message:
      'Codex CLI 기존 로그인을 사용합니다. Fleet 은 자격증명을 읽지 않습니다. 조직/상업/공유 환경은 OpenAI 약관·계정 정책을 확인하세요. 정책/플랜별 허용 범위가 달라질 수 있어 API 키가 더 명시적입니다.',
  },
  google: {
    level: 'warning',
    recommendApi: true,
    message:
      'Gemini CLI 의 Google 계정/OAuth 사용은 Google 정책·Gemini CLI 약관 적용을 받습니다. 제3자 소프트웨어의 OAuth 기반 자동화/우회 통합은 제한·탐지 대상이 될 수 있습니다. 계정 리스크를 피하려면 API 키를 권장합니다. Fleet 은 Google 자격증명을 저장/읽지 않습니다.',
  },
  'openai-compatible': null,
}

export function subscriptionSupported(provider: Provider): boolean {
  return SUBSCRIPTION_BANNERS[provider] !== null
}
