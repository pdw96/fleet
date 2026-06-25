import { useRef, useState } from 'react'
import type {
  ApiProviderConfig,
  CacheTtl,
  CliDetectionResult,
  ModelOption,
  ReasoningEffort,
} from '../../shared/types'
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

const PROVIDER_DEFAULTS: Record<Provider, string> = {
  anthropic: 'claude-sonnet-4-6',
  openai: 'gpt-5.5',
  google: 'gemini-3.5-flash',
  'openai-compatible': '',
}

export function AddAiWizard({ onRegistered }: { onRegistered: () => void }) {
  const [step, setStep] = useState<Step>('provider')
  const [provider, setProvider] = useState<Provider>('anthropic')
  const [clis, setClis] = useState<CliDetectionResult[]>([])
  const [err, setErr] = useState<string | null>(null)

  // API 키 단계 상태
  const [apiKey, setApiKey] = useState('')
  const [model, setModel] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [effort, setEffort] = useState<'' | ReasoningEffort>('')
  const [cacheTtl, setCacheTtl] = useState<'' | CacheTtl>('')
  const [modelOptions, setModelOptions] = useState<ModelOption[]>([])
  const [loadingModels, setLoadingModels] = useState(false)
  // 모델 조회 요청 시퀀스 — provider/key/baseUrl 이 바뀌면 증가시켜, 이전 입력으로 보낸 in-flight 응답이
  // 늦게 도착해 stale 한 제안으로 datalist 를 덮어쓰는 레이스를 막는다(SessionsPanel 레이스 가드 동형).
  const modelReqSeq = useRef(0)

  // 구독 단계 — CLI 세션 옵션(SessionsPanel 동형)
  const [cliStateful, setCliStateful] = useState(false)
  const [cliModel, setCliModel] = useState('')
  const [cliMcp, setCliMcp] = useState('')

  function enterSubscription() {
    setStep('subscription')
    setErr(null)
    void window.fleet
      .detectClis()
      .then(setClis)
      .catch((e) => setErr(String(e)))
  }

  // provider 전환 시 모델 관련 상태 초기화 — stale 제안·in-flight 레이스 방지
  function switchProvider(p: Provider) {
    setProvider(p)
    setModel('')
    invalidateModelLookup()
  }

  // provider/key/baseUrl 변경 시 stale 제안·in-flight·로딩 상태를 즉시 정리한다(SessionsPanel 동형).
  // 느린/불통 엔드포인트의 in-flight 요청이 settle 될 때까지 버튼이 잠기던 stuck 제거.
  function invalidateModelLookup() {
    setModelOptions([])
    setLoadingModels(false)
    modelReqSeq.current++
  }

  // 명시적 버튼으로만 호출 — 키스트로크마다 실 엔드포인트를 두드리지 않는다(SessionsPanel 동형).
  async function loadModels() {
    if (!apiKey.trim()) return
    if (provider === 'openai-compatible' && !baseUrl.trim()) return
    const seq = ++modelReqSeq.current
    setLoadingModels(true)
    setErr(null)
    try {
      const probe: ApiProviderConfig = {
        id: `probe-${provider}`,
        provider,
        displayName: provider,
        model: model.trim() || PROVIDER_DEFAULTS[provider],
        apiKey: apiKey.trim(),
        ...(provider === 'openai-compatible' ? { baseUrl: baseUrl.trim() } : {}),
      }
      const options = await window.fleet.listModels(probe)
      if (seq === modelReqSeq.current) setModelOptions(options)
    } catch (e) {
      if (seq === modelReqSeq.current) setErr(`모델 조회 실패: ${String(e)}`)
    } finally {
      if (seq === modelReqSeq.current) setLoadingModels(false)
    }
  }

  // thinkingSupported: SessionsPanel 동형 — anthropic·openai·google·openai-compatible 전체
  const thinkingSupported =
    provider === 'anthropic' ||
    provider === 'openai' ||
    provider === 'google' ||
    provider === 'openai-compatible'

  if (step === 'provider') {
    return (
      <div>
        <h3>AI 추가 — 프로바이더 선택</h3>
        {PROVIDERS.map((p) => (
          <button
            key={p.id}
            onClick={() => {
              switchProvider(p.id)
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
            <label>
              <input
                type="checkbox"
                aria-label="stateful (세션 재개)"
                checked={cliStateful}
                onChange={(e) => setCliStateful(e.target.checked)}
              />
              stateful (세션 재개)
            </label>
            <label>
              CLI 모델 오버라이드 (선택)
              <input
                aria-label="CLI 모델"
                value={cliModel}
                placeholder="기본 모델 사용"
                onChange={(e) => setCliModel(e.target.value)}
              />
            </label>
            <label>
              MCP 설정 (선택)
              <input
                aria-label="MCP 설정"
                value={cliMcp}
                placeholder="경로 또는 인라인 JSON"
                onChange={(e) => setCliMcp(e.target.value)}
              />
            </label>
            <button
              type="button"
              onClick={() => {
                setErr(null)
                const opts: { stateful: boolean; model?: string; mcpConfig?: string } = {
                  stateful: cliStateful,
                }
                const m = cliModel.trim()
                const mc = cliMcp.trim()
                if (m) opts.model = m
                if (mc) opts.mcpConfig = mc
                void window.fleet
                  .registerCliSession(adapterId, opts)
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

  // step === 'apikey'
  async function submit() {
    setErr(null)
    if (provider === 'openai-compatible' && !baseUrl.trim()) {
      setErr('openai-compatible 은 baseUrl 이 필요합니다.')
      return
    }
    const config: ApiProviderConfig = {
      id: `${provider}-${Date.now()}`,
      provider,
      displayName: provider,
      model: model.trim() || PROVIDER_DEFAULTS[provider],
      apiKey: apiKey.trim() || undefined,
      ...(provider === 'openai-compatible' ? { baseUrl: baseUrl.trim() } : {}),
      ...(effort ? { thinking: { effort } } : {}),
      ...(provider === 'anthropic' && cacheTtl ? { cacheTtl } : {}),
    }
    try {
      await window.fleet.registerApiSession(config)
      onRegistered()
    } catch (e) {
      setErr(`등록 실패: ${String(e)}`)
    }
  }

  const canLoadModels =
    !!apiKey.trim() && !(provider === 'openai-compatible' && !baseUrl.trim()) && !loadingModels

  return (
    <div>
      <h3>API 키</h3>
      <label>
        API 키
        <input
          aria-label="API 키"
          value={apiKey}
          onChange={(e) => {
            setApiKey(e.target.value)
            invalidateModelLookup() // 키 변경 → stale 제안·in-flight·로딩 정리
          }}
        />
      </label>
      <label>
        모델
        <input
          aria-label="모델"
          list="wizard-models"
          value={model}
          placeholder={PROVIDER_DEFAULTS[provider]}
          onChange={(e) => setModel(e.target.value)}
        />
      </label>
      <datalist id="wizard-models">
        {modelOptions.map((m) => (
          <option key={m.id} value={m.id}>
            {m.id}
            {m.label ? ` — ${m.label}` : ''}
          </option>
        ))}
      </datalist>
      <button
        type="button"
        disabled={!canLoadModels}
        onClick={() => {
          void loadModels()
        }}
      >
        {loadingModels ? '불러오는 중…' : '모델 불러오기'}
      </button>
      {provider === 'openai-compatible' && (
        <label>
          Base URL
          <input
            aria-label="Base URL"
            value={baseUrl}
            onChange={(e) => {
              setBaseUrl(e.target.value)
              invalidateModelLookup() // baseUrl 변경 → stale 제안·in-flight·로딩 정리
            }}
          />
        </label>
      )}
      {thinkingSupported && (
        <label>
          thinking effort
          <select
            aria-label="thinking effort"
            value={effort}
            onChange={(e) => setEffort(e.target.value as '' | ReasoningEffort)}
          >
            <option value="">off</option>
            <option value="low">low</option>
            <option value="medium">medium</option>
            <option value="high">high</option>
            <option value="xhigh">xhigh</option>
            <option value="max">max</option>
          </select>
        </label>
      )}
      {provider === 'anthropic' && (
        <label>
          cache TTL
          <select
            aria-label="cache TTL"
            value={cacheTtl}
            onChange={(e) => setCacheTtl(e.target.value as '' | CacheTtl)}
          >
            <option value="">5m</option>
            <option value="1h">1h</option>
          </select>
        </label>
      )}
      <button onClick={() => void submit()}>등록</button>
      {err && <p role="alert">{err}</p>}
      <button onClick={() => setStep('method')}>뒤로</button>
    </div>
  )
}
