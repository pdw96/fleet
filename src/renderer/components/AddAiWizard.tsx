import { useState } from 'react'
import type { ApiProviderConfig, CliDetectionResult } from '../../shared/types'
import { CLI_AUTH_INSTALL_META } from '../../shared/cliAuthInstallMeta'
import { SUBSCRIPTION_BANNERS, subscriptionSupported } from './authBanners'

type Provider = ApiProviderConfig['provider']
type Step = 'provider' | 'method' | 'subscription' | 'apikey'

const PROVIDERS: { id: Provider; label: string }[] = [
  { id: 'anthropic', label: 'Claude (Anthropic)' },
  { id: 'openai', label: 'Codex (OpenAI)' },
  { id: 'google', label: 'Gemini (Google)' },
  { id: 'openai-compatible', label: 'OpenAI 호환' },
]

const ADAPTER_ID: Partial<Record<Provider, 'claude' | 'codex' | 'gemini'>> = {
  anthropic: 'claude',
  openai: 'codex',
  google: 'gemini',
}

export function AddAiWizard({ onRegistered }: { onRegistered: () => void }) {
  const [step, setStep] = useState<Step>('provider')
  const [provider, setProvider] = useState<Provider>('anthropic')
  const [clis, setClis] = useState<CliDetectionResult[]>([])
  const [err, setErr] = useState<string | null>(null)

  function enterSubscription() {
    setStep('subscription')
    setErr(null)
    void window.fleet
      .detectClis()
      .then(setClis)
      .catch((e) => setErr(String(e)))
  }

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
          <button onClick={enterSubscription}>구독 (공식 CLI)</button>
        )}
        <button onClick={() => setStep('apikey')}>API 키</button>
        <button onClick={() => setStep('provider')}>뒤로</button>
      </div>
    )
  }
  if (step === 'subscription') {
    const adapterId = ADAPTER_ID[provider]!
    const meta = CLI_AUTH_INSTALL_META[adapterId]
    const banner = SUBSCRIPTION_BANNERS[provider]
    const installed = !!clis.find((c) => c.id === adapterId)?.installed
    return (
      <div>
        <h3>구독 (공식 CLI 위임)</h3>
        {banner && (
          <p role="note" data-level={banner.level}>
            {banner.message}
            {banner.recommendApi ? ' (API 키 권장)' : ''}
          </p>
        )}
        <p>공식 문서 URL:</p>
        <code>{meta.docsUrl}</code>
        <button type="button" onClick={() => void navigator.clipboard?.writeText(meta.docsUrl)}>
          URL 복사
        </button>
        {!installed ? (
          <div>
            <p>CLI 미설치 — 설치 후 &quot;재확인&quot;:</p>
            <code>{meta.installHint}</code>
            <button
              type="button"
              onClick={() => void navigator.clipboard?.writeText(meta.installHint)}
            >
              명령 복사
            </button>
            <button type="button" onClick={() => void window.fleet.detectClis().then(setClis)}>
              재확인 (설치 확인)
            </button>
          </div>
        ) : (
          <div>
            <p>로그인이 안 돼 있다면 터미널에서 실행(복사):</p>
            <code>{meta.loginCommand}</code>
            <button
              type="button"
              onClick={() => void navigator.clipboard?.writeText(meta.loginCommand)}
            >
              명령 복사
            </button>
            <button
              type="button"
              onClick={() => {
                setErr(null)
                void window.fleet
                  .registerCliSession(adapterId, { stateful: false })
                  .then(() => onRegistered())
                  .catch((e: unknown) => setErr(`등록 실패: ${String(e)}`))
              }}
            >
              검증 없이 등록
            </button>
          </div>
        )}
        {err && <p role="alert">{err}</p>}
        <button onClick={() => setStep('method')}>뒤로</button>
      </div>
    )
  }
  return (
    <div data-provider={provider} data-step={step}>
      {/* Task 6 */}
    </div>
  )
}
