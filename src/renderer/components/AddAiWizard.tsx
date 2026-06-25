import { useState } from 'react'
import type { ApiProviderConfig } from '../../shared/types'
import { subscriptionSupported } from './authBanners'

type Provider = ApiProviderConfig['provider']
type Step = 'provider' | 'method' | 'subscription' | 'apikey'

const PROVIDERS: { id: Provider; label: string }[] = [
  { id: 'anthropic', label: 'Claude (Anthropic)' },
  { id: 'openai', label: 'Codex (OpenAI)' },
  { id: 'google', label: 'Gemini (Google)' },
  { id: 'openai-compatible', label: 'OpenAI 호환' },
]

export function AddAiWizard({ onRegistered }: { onRegistered: () => void }) {
  const [step, setStep] = useState<Step>('provider')
  const [provider, setProvider] = useState<Provider>('anthropic')

  if (step === 'provider') {
    return (
      <div>
        <h3>AI 추가 — 프로바이더 선택</h3>
        {PROVIDERS.map((p) => (
          <button
            key={p.id}
            onClick={() => {
              setProvider(p.id)
              setStep('method')
            }}
          >
            {p.label}
          </button>
        ))}
      </div>
    )
  }
  if (step === 'method') {
    return (
      <div>
        <h3>인증 방식</h3>
        {subscriptionSupported(provider) && (
          <button onClick={() => setStep('subscription')}>구독 (공식 CLI)</button>
        )}
        <button onClick={() => setStep('apikey')}>API 키</button>
        <button onClick={() => setStep('provider')}>뒤로</button>
      </div>
    )
  }
  return (
    <div data-provider={provider} data-step={step}>
      {/* Task 5·6 */}
    </div>
  )
}
