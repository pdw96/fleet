import { useRef, useState } from 'react'
import type {
  ApiProviderConfig,
  CacheTtl,
  CliAdapterId,
  CliDetectionResult,
  ModelOption,
  ProbeResult,
  ReasoningEffort,
} from '../../shared/types'
import { CLI_AUTH_INSTALL_META } from '../../shared/cliAuthInstallMeta'
import { SUBSCRIPTION_BANNERS, subscriptionSupported } from './authBanners'

type Provider = ApiProviderConfig['provider']
type Step = 'provider' | 'method' | 'subscription' | 'apikey'

/** probe 결과를 사용자용 transient 문구로 변환(저장 상태 아님 — 일회성 결과임을 명시). */
function probeResultText(r: ProbeResult): string {
  switch (r.status) {
    case 'ok':
      return '✓ 방금 연결 테스트 성공 — 이 결과는 저장되지 않습니다.'
    case 'auth':
      // hint(classifyCliAuthHint)는 이미 💡 로 시작하는 자기완결 advisory → ⚠ 접두 생략(이중 이모지 방지).
      return `${r.hint ?? '⚠ 인증 문제일 수 있습니다.'} — 그래도 등록할 수 있습니다.`
    case 'timeout':
      return '⏱ 시간 초과 — 그래도 등록할 수 있습니다.'
    default:
      return `⚠ 연결 테스트 실패 — 그래도 등록할 수 있습니다.${r.detail ? ` (${r.detail})` : ''}`
  }
}

const PROVIDERS: { id: Provider; label: string }[] = [
  { id: 'anthropic', label: 'Claude (Anthropic)' },
  { id: 'openai', label: 'Codex (OpenAI)' },
  { id: 'google', label: 'Gemini (Google)' },
  { id: 'openai-compatible', label: 'OpenAI 호환' },
]

const ADAPTER_ID: Partial<Record<Provider, CliAdapterId>> = {
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
  // 등록 진행 중 이중 제출 방지(SessionsPanel busy 동형)
  const [submitting, setSubmitting] = useState(false)
  // 연결 테스트(probe) — transient 결과(저장 안 함, #150). probing 은 등록(submitting)과 분리(비차단).
  const [probing, setProbing] = useState(false)
  const [probeMsg, setProbeMsg] = useState<string | null>(null)

  function enterSubscription() {
    setStep('subscription')
    setErr(null)
    setClis([])
    // 직전 어댑터의 transient probe 결과를 폐기(어댑터 전환 시 stale 성공/실패가 다른 CLI 에 귀속되는 것 방지).
    setProbeMsg(null)
    setProbing(false)
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
        <button
          type="button"
          onClick={() => {
            setErr(null)
            void window.fleet
              .openCliDocs(adapterId)
              .catch(() => setErr('문서 열기에 실패했습니다.'))
          }}
        >
          문서 열기
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
            <button
              type="button"
              onClick={() =>
                void window.fleet
                  .detectClis()
                  .then(setClis)
                  .catch((e: unknown) => setErr(String(e)))
              }
            >
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
              disabled={submitting}
              onClick={() => {
                if (submitting) return
                setErr(null)
                const opts: { stateful: boolean; model?: string; mcpConfig?: string } = {
                  stateful: cliStateful,
                }
                const m = cliModel.trim()
                const mc = cliMcp.trim()
                if (m) opts.model = m
                if (mc) opts.mcpConfig = mc
                setSubmitting(true)
                void window.fleet
                  .registerCliSession(adapterId, opts)
                  .then(() => onRegistered())
                  .catch((e: unknown) => setErr(`등록 실패: ${String(e)}`))
                  .finally(() => setSubmitting(false))
              }}
            >
              검증 없이 등록
            </button>
            <button
              type="button"
              disabled={probing}
              title="선택한 CLI로 짧은 실제 모델 호출을 1회 실행합니다. 구독/쿼터/요금이 사용될 수 있습니다."
              onClick={() => {
                setProbeMsg(null)
                setProbing(true)
                void window.fleet
                  .probeCli(adapterId)
                  .then((r) => setProbeMsg(probeResultText(r)))
                  .catch(() =>
                    setProbeMsg('⚠ 연결 테스트를 실행하지 못했습니다 — 그래도 등록할 수 있습니다.'),
                  )
                  .finally(() => setProbing(false))
              }}
            >
              {probing ? '연결 테스트 중…' : '연결 테스트'}
            </button>
            <p className="meta">
              연결 테스트는 짧은 실제 모델 호출을 1회 실행합니다(구독/쿼터/요금 사용 가능).
            </p>
            {probeMsg && <p role="status">{probeMsg}</p>}
          </div>
        )}
        {err && <p role="alert">{err}</p>}
        <button onClick={() => setStep('method')}>뒤로</button>
      </div>
    )
  }

  // step === 'apikey'
  async function submit() {
    if (submitting) return
    setErr(null)
    if (!apiKey.trim()) {
      setErr('API 키를 입력하세요.')
      return
    }
    if (provider === 'openai-compatible') {
      if (!baseUrl.trim()) {
        setErr('openai-compatible 은 baseUrl 이 필요합니다.')
        return
      }
      try {
        const parsed = new URL(baseUrl.trim())
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          setErr('baseUrl 은 http:// 또는 https:// 여야 합니다.')
          return
        }
      } catch {
        setErr('baseUrl 이 올바른 URL 형식이 아닙니다.')
        return
      }
    }
    const resolvedModel = model.trim() || PROVIDER_DEFAULTS[provider]
    if (provider === 'openai-compatible' && !resolvedModel) {
      setErr('openai-compatible 은 모델을 입력하세요.')
      return
    }
    const thinkingOn = effort !== ''
    const cacheOn = provider === 'anthropic' && cacheTtl === '1h'
    const config: ApiProviderConfig = {
      id: `${provider}-${Date.now()}`,
      provider,
      displayName: `${provider} (${resolvedModel}${thinkingOn ? `, thinking:${effort}` : ''}${cacheOn ? ', cache:1h' : ''})`,
      model: resolvedModel,
      apiKey: apiKey.trim(),
      ...(provider === 'openai-compatible' ? { baseUrl: baseUrl.trim() } : {}),
      ...(thinkingOn ? { thinking: { effort } } : {}),
      ...(cacheOn ? { cacheTtl: '1h' } : {}),
    }
    setSubmitting(true)
    try {
      await window.fleet.registerApiSession(config)
      setApiKey('')
      onRegistered()
    } catch (e) {
      setErr(`등록 실패: ${String(e)}`)
    } finally {
      setSubmitting(false)
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
          type="password"
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
      <button disabled={submitting} onClick={() => void submit()}>
        {submitting ? '등록 중…' : '등록'}
      </button>
      {err && <p role="alert">{err}</p>}
      <button onClick={() => setStep('method')}>뒤로</button>
    </div>
  )
}
