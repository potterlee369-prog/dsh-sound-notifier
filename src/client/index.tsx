// Client plugin: plays synthesized sounds in the browser when a session task
// finishes or when the UI asks the user to choose from options, and registers
// a settings section where the user can enable/disable sounds, pick sound
// types, adjust the volume, and preview playback.
//
// Completion detection: subscribes to the `sessions` list store and watches
// the `running: true -> false` edge per session — the same signal the sidebar
// uses for its green "done" reminder. Subagent-origin sessions are skipped
// unless configured otherwise.
//
// Natural completion vs interruption: for the currently selected (staged)
// session the event window is live, so the turn/end reason classifies the
// edge — `completed` plays the completion sound, while `aborted` (user Stop),
// `error`, `interrupted` (crash repair), `blocked` (rejected step) and
// `max-tokens` (truncated output) play the interruption sound. Background
// sessions have no event window and fall back to the completion sound.
//
// User-choice detection: watches `sessions.list` rows for a newly pending
// `question` / `plan-review` interaction — the same state that makes the UI
// pop up options for `ask_user_question` and plan approvals. It plays a
// separate prompt sound. Permission-approval prompts are optional and off by
// default.
//
// Playback uses the Web Audio API (oscillators, no audio assets); a
// BroadcastChannel claim protocol dedupes the same completion across multiple
// open tabs.
import { useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import css from './index.css'

const NS = 'sound-notifier'
const CSS_TAG = 'dsh-sound-notifier/index.css'
const STORAGE_KEY = 'dsh.sound-notifier.v1'
const COOLDOWN_MS = 1000
const CLAIM_WINDOW_MS = 80
const CHANNEL_NAME = 'dsh-sound-notifier'

// Inject the stylesheet once, at module materialization — the same
// data-plugin-css pattern the harness's own client bundles use.
if (typeof document !== 'undefined' && document.querySelector(`style[data-plugin-css="${CSS_TAG}"]`) === null) {
  const tag = document.createElement('style')
  tag.dataset.plugin = 'dsh-sound-notifier'
  tag.dataset.pluginCss = CSS_TAG
  tag.textContent = css
  document.head.appendChild(tag)
}

// ── configuration (per-browser, localStorage) ──────────────────────────────

export type SoundId = 'chime' | 'ding' | 'success' | 'ping'

export type CompletionKind = 'done' | 'interrupted'
export type PromptKind = 'question' | 'approval'
export type NotifyKind = CompletionKind | PromptKind

export interface SoundConfig {
  enabled: boolean
  /** Sound for a naturally completed task. */
  sound: SoundId
  /** Sound for a task interrupted mid-way (stop, error, truncation, ...). */
  interruptedSound: SoundId
  /** Play a separate sound when the UI asks the user to choose from options. */
  promptEnabled: boolean
  /** Sound for user-choice prompts (ask_user_question / plan review). */
  promptSound: SoundId
  /** Also play for permission-approval prompts. */
  approvalEnabled: boolean
  volume: number
  /** Only play when the completing session is the one selected in view. */
  onlySelected: boolean
  /** Also play when a subagent child session completes. */
  includeSubagents: boolean
}

const SOUND_IDS: readonly SoundId[] = ['chime', 'ding', 'success', 'ping']

const DEFAULT_CONFIG: SoundConfig = {
  enabled: true,
  sound: 'chime',
  interruptedSound: 'ping',
  promptEnabled: true,
  promptSound: 'ding',
  approvalEnabled: false,
  volume: 0.6,
  onlySelected: false,
  includeSubagents: false,
}

function normalizeConfig(raw: unknown): SoundConfig {
  const source = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
  return {
    enabled: typeof source.enabled === 'boolean' ? source.enabled : DEFAULT_CONFIG.enabled,
    sound:
      typeof source.sound === 'string' && SOUND_IDS.includes(source.sound as SoundId)
        ? (source.sound as SoundId)
        : DEFAULT_CONFIG.sound,
    interruptedSound:
      typeof source.interruptedSound === 'string' && SOUND_IDS.includes(source.interruptedSound as SoundId)
        ? (source.interruptedSound as SoundId)
        : DEFAULT_CONFIG.interruptedSound,
    promptEnabled: typeof source.promptEnabled === 'boolean' ? source.promptEnabled : DEFAULT_CONFIG.promptEnabled,
    promptSound:
      typeof source.promptSound === 'string' && SOUND_IDS.includes(source.promptSound as SoundId)
        ? (source.promptSound as SoundId)
        : DEFAULT_CONFIG.promptSound,
    approvalEnabled: typeof source.approvalEnabled === 'boolean' ? source.approvalEnabled : DEFAULT_CONFIG.approvalEnabled,
    volume:
      typeof source.volume === 'number' && Number.isFinite(source.volume)
        ? Math.min(1, Math.max(0, source.volume))
        : DEFAULT_CONFIG.volume,
    onlySelected: typeof source.onlySelected === 'boolean' ? source.onlySelected : DEFAULT_CONFIG.onlySelected,
    includeSubagents:
      typeof source.includeSubagents === 'boolean' ? source.includeSubagents : DEFAULT_CONFIG.includeSubagents,
  }
}

function loadConfig(): SoundConfig {
  if (typeof localStorage === 'undefined') return { ...DEFAULT_CONFIG }
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw === null ? { ...DEFAULT_CONFIG } : normalizeConfig(JSON.parse(raw))
  } catch {
    return { ...DEFAULT_CONFIG }
  }
}

function saveConfig(config: SoundConfig): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(config))
  } catch {
    // Storage unavailable (private mode, quota): keep the in-memory value.
  }
}

let configSnapshot: SoundConfig = loadConfig()
const configListeners = new Set<() => void>()

const configStore = {
  getSnapshot: (): SoundConfig => configSnapshot,
  subscribe: (listener: () => void): (() => void) => {
    configListeners.add(listener)
    return () => {
      configListeners.delete(listener)
    }
  },
  update: (patch: Partial<SoundConfig>): void => {
    configSnapshot = { ...configSnapshot, ...patch }
    saveConfig(configSnapshot)
    for (const listener of [...configListeners]) listener()
  },
}

// ── completion classification ───────────────────────────────────────────────

/** turn/end reasons that mean the task did NOT finish naturally. */
const INTERRUPT_KINDS = new Set(['aborted', 'error', 'interrupted', 'blocked', 'max-tokens'])

function classifyTurnEnd(reasonKind: unknown): CompletionKind {
  return typeof reasonKind === 'string' && INTERRUPT_KINDS.has(reasonKind) ? 'interrupted' : 'done'
}

interface TurnEndEvent {
  type: 'turn/end'
  seq: number
  data?: { reason?: { kind?: unknown } }
}

/** The most recent turn/end event in a session event window, if any. */
function lastTurnEnd(events: readonly SessionEvent[]): TurnEndEvent | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event.type === 'turn/end') return event as TurnEndEvent
  }
  return undefined
}

// ── Web Audio engine ────────────────────────────────────────────────────────

interface Note {
  freq: number
  /** Start offset in seconds from the play moment. */
  at: number
  dur: number
  type: OscillatorType
  gain: number
  /** Add a quiet inharmonic partial for a bell-like timbre. */
  bell?: boolean
}

const MELODIES: Record<SoundId, readonly Note[]> = {
  chime: [
    { freq: 1046.5, at: 0, dur: 1.15, type: 'sine', gain: 0.42, bell: true },
    { freq: 1318.51, at: 0.22, dur: 1.3, type: 'sine', gain: 0.4, bell: true },
  ],
  ding: [{ freq: 880, at: 0, dur: 0.75, type: 'sine', gain: 0.5, bell: true }],
  success: [
    { freq: 523.25, at: 0, dur: 0.5, type: 'triangle', gain: 0.32 },
    { freq: 659.25, at: 0.12, dur: 0.5, type: 'triangle', gain: 0.32 },
    { freq: 783.99, at: 0.24, dur: 0.5, type: 'triangle', gain: 0.32 },
    { freq: 1046.5, at: 0.36, dur: 0.7, type: 'triangle', gain: 0.36 },
  ],
  ping: [{ freq: 1318.51, at: 0, dur: 0.32, type: 'sine', gain: 0.3 }],
}

let audioContext: AudioContext | null = null
let unlockInstalled = false
/** Per-kind cooldown timestamps so a completion, interruption, and prompt close together each ring. */
const lastPlayAt: Record<NotifyKind, number> = { done: 0, interrupted: 0, question: 0, approval: 0 }
let channel: BroadcastChannel | null = null

function ensureContext(): AudioContext | null {
  if (typeof window === 'undefined') return null
  if (audioContext === null) {
    try {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      if (Ctor === undefined) return null
      audioContext = new Ctor()
    } catch {
      return null
    }
  }
  if (audioContext.state === 'suspended') {
    void audioContext.resume().catch(() => {})
  }
  return audioContext
}

/** Browsers require a user gesture before audio may start; unlock on the first one. */
function installUnlock(): void {
  if (unlockInstalled || typeof window === 'undefined') return
  unlockInstalled = true
  const unlock = (): void => {
    ensureContext()
  }
  window.addEventListener('pointerdown', unlock, { once: true, passive: true })
  window.addEventListener('keydown', unlock, { once: true, passive: true })
}

/** Synthesize one melody. Returns false when audio is not (yet) available. */
function playSound(sound: SoundId, volume: number): boolean {
  const ctx = ensureContext()
  if (ctx === null || ctx.state !== 'running') return false
  const level = Math.min(1, Math.max(0, volume))
  if (level === 0) return true
  const t0 = ctx.currentTime + 0.02
  for (const note of MELODIES[sound]) {
    const peak = note.gain * level
    const start = t0 + note.at
    const end = start + note.dur
    const osc = ctx.createOscillator()
    osc.type = note.type
    osc.frequency.value = note.freq
    const env = ctx.createGain()
    env.gain.setValueAtTime(0.0001, start)
    env.gain.exponentialRampToValueAtTime(Math.max(peak, 0.0001), start + 0.012)
    env.gain.exponentialRampToValueAtTime(0.0001, end)
    osc.connect(env)
    env.connect(ctx.destination)
    osc.start(start)
    osc.stop(end + 0.05)
    if (note.bell === true) {
      const partial = ctx.createOscillator()
      partial.type = 'sine'
      partial.frequency.value = note.freq * 2.756
      const partialEnv = ctx.createGain()
      partialEnv.gain.setValueAtTime(0.0001, start)
      partialEnv.gain.exponentialRampToValueAtTime(Math.max(peak * 0.28, 0.0001), start + 0.008)
      partialEnv.gain.exponentialRampToValueAtTime(0.0001, start + note.dur * 0.55)
      partial.connect(partialEnv)
      partialEnv.connect(ctx.destination)
      partial.start(start)
      partial.stop(start + note.dur * 0.55 + 0.05)
    }
  }
  return true
}

function getChannel(): BroadcastChannel | null {
  if (typeof BroadcastChannel === 'undefined') return null
  if (channel === null) channel = new BroadcastChannel(CHANNEL_NAME)
  return channel
}

/**
 * Play for one session notification (completion or user prompt), deduped
 * across tabs: every tab broadcasts a claim and waits a short window; the tab
 * with the smallest timestamp wins, so N open tabs produce exactly one sound.
 */
function notifySessionSound(sessionId: string, kind: NotifyKind, config: SoundConfig): void {
  const now = Date.now()
  if (now - lastPlayAt[kind] < COOLDOWN_MS) return
  lastPlayAt[kind] = now
  const sound =
    kind === 'interrupted'
      ? config.interruptedSound
      : kind === 'question' || kind === 'approval'
        ? config.promptSound
        : config.sound
  const ch = getChannel()
  if (ch === null) {
    playSound(sound, config.volume)
    return
  }
  const claimTime = now
  let cancelled = false
  const onMessage = (event: MessageEvent): void => {
    const data = event.data as { sessionId?: unknown; kind?: unknown; t?: unknown } | null
    if (
      data !== null &&
      typeof data === 'object' &&
      data.sessionId === sessionId &&
      data.kind === kind &&
      typeof data.t === 'number' &&
      data.t < claimTime
    ) {
      cancelled = true
    }
  }
  ch.addEventListener('message', onMessage)
  try {
    ch.postMessage({ sessionId, kind, t: claimTime })
  } catch {
    // Channel closed by another tab teardown: fall through to local play.
  }
  window.setTimeout(() => {
    ch.removeEventListener('message', onMessage)
    if (!cancelled) playSound(sound, config.volume)
  }, CLAIM_WINDOW_MS)
}

// ── minimal structural faces of the client services we consume ─────────────

interface SessionEvent {
  type: string
  seq: number
}

interface SessionInstance {
  events: SessionEvent[]
}

type PendingInteractionStatus = 'approval' | 'plan-review' | 'question'

interface SessionRow {
  id: string
  running?: boolean
  origin?: string
  pendingInteraction?: PendingInteractionStatus
}

interface SessionsSnapshot {
  ids?: string[]
  byId?: Record<string, SessionRow>
  current?: string
  phase?: 'pending' | 'ready'
}

interface SessionsListStore {
  subscribe(listener: () => void): () => void
  getSnapshot(): SessionsSnapshot
}

interface SessionsService {
  list: SessionsListStore
  /** Instance cluster; entries are created lazily for opened sessions. */
  manager?: { sessions?: Map<string, SessionInstance> }
}

interface Slots {
  inject(name: string, register: () => void): void
  register(options: Record<string, unknown>, component: unknown): void
}

interface Locale {
  register(namespace: string, dictionaries: Record<'zh' | 'en', Record<string, string>>): () => void
  bind(namespace: string): (key: string) => string
}

interface ClientContext {
  sessions: SessionsService
  slots: Slots
  locale: Locale
  effect(callback: () => () => void, label: string): void
}

// ── plugin entry ────────────────────────────────────────────────────────────

export const inject = ['sessions', 'slots', 'locale']

export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-sound-notifier: dictionaries')
  const t = ctx.locale.bind(NS)

  ctx.effect(() => {
    installUnlock()
    const prevRunning = new Map<string, boolean>()
    const prevPending = new Map<string, PendingInteractionStatus | undefined>()
    const dispose = ctx.sessions.list.subscribe(() => {
      const snap = ctx.sessions.list.getSnapshot()
      // The baseline pull replaces the whole list; only act once it settled so
      // reconnect re-pulls cannot fabricate edges.
      if (snap.phase !== 'ready') return
      const ids = snap.ids ?? []
      const byId = snap.byId ?? {}
      const seen = new Set<string>()
      for (const id of ids) {
        seen.add(id)
        const row = byId[id]
        if (row === undefined) continue
        const config = configStore.getSnapshot()
        // Completion edge: running true → false.
        const was = prevRunning.get(id)
        const is = row.running === true
        prevRunning.set(id, is)
        if (
          was === true &&
          !is &&
          config.enabled &&
          !(row.origin === 'subagent' && !config.includeSubagents) &&
          !(config.onlySelected && id !== snap.current)
        ) {
          const kind = classifyEdge(id, id === snap.current, ctx)
          notifySessionSound(id, kind, config)
        }
        // User-choice detection: a pending interaction appearing in the list
        // means the UI has popped up options the user needs to answer. Treat
        // `question` and the special-cased `plan-review` as one prompt kind;
        // `approval` is opt-in. This is independent of the completion switch.
        const pendingWasSeen = prevPending.has(id)
        const pendingWas = prevPending.get(id)
        const pendingIs = row.pendingInteraction
        prevPending.set(id, pendingIs)
        if (pendingWasSeen && pendingWas !== pendingIs && pendingIs !== undefined) {
          if (pendingIs === 'approval') {
            if (config.promptEnabled && config.approvalEnabled) notifySessionSound(id, 'approval', config)
          } else if (config.promptEnabled) {
            notifySessionSound(id, 'question', config)
          }
        }
      }
      for (const key of prevRunning.keys()) if (!seen.has(key)) prevRunning.delete(key)
      for (const key of prevPending.keys()) if (!seen.has(key)) prevPending.delete(key)
    })
    return dispose
  }, 'dsh-sound-notifier: completion & prompt watcher')

  ctx.slots.inject(
    'settings.section',
    () =>
      ctx.slots.register(
        {
          name: 'settings.section',
          id: 'sound-notifier',
          order: 20,
          label: () => t('nav'),
          locale: NS,
          children: { 'settings.sound-notifier.item': { kind: 'list', scope: 'root' } },
        },
        SoundSection,
      ),
  )

  ctx.slots.inject(
    'settings.sound-notifier.item',
    () =>
      ctx.slots.register(
        {
          name: 'settings.sound-notifier.item',
          id: 'sound-notifier-card',
          order: 0,
          locale: NS,
        },
        SoundCard,
      ),
  )
}

/**
 * Classify one running→idle edge. Only the currently selected session has a
 * live event window with the authoritative turn/end reason; everything else
 * falls back to the completion sound. The event window shares one ordered
 * connection with the status stream, so the turn/end of the finished run is
 * already visible when the edge is observed.
 */
function classifyEdge(sessionId: string, isCurrent: boolean, ctx: ClientContext): CompletionKind {
  if (!isCurrent) return 'done'
  const session = ctx.sessions.manager?.sessions?.get(sessionId)
  if (session === undefined) return 'done'
  const end = lastTurnEnd(session.events)
  if (end === undefined) return 'done'
  return classifyTurnEnd(end.data?.reason?.kind)
}

// ── settings UI ─────────────────────────────────────────────────────────────

function SoundSection({ renderSlot }: { renderSlot: (name: string, props: Record<string, never>) => ReactNode }) {
  return <div className="sn-section">{renderSlot('settings.sound-notifier.item', {})}</div>
}

function SoundCard({ t }: { t: (key: string) => string }) {
  const config = useSyncExternalStore(configStore.subscribe, configStore.getSnapshot)
  const set = (patch: Partial<SoundConfig>): void => {
    configStore.update(patch)
  }
  const preview = (sound: SoundId): void => {
    for (const key of Object.keys(lastPlayAt) as NotifyKind[]) lastPlayAt[key] = 0
    installUnlock()
    playSound(sound, config.volume)
  }
  return (
    <div className="sn-card">
      <div className="sn-title">{t('title')}</div>
      <div className="sn-row">
        <span className="sn-label">{t('enabled')}</span>
        <label className="sn-switch">
          <input type="checkbox" checked={config.enabled} onChange={(event) => set({ enabled: event.target.checked })} aria-label={t('enabled')} />
          <span className="sn-track" aria-hidden="true" />
        </label>
      </div>
      <SoundPickerRow label={t('sound.done')} value={config.sound} onValue={(sound) => set({ sound })} onPreview={preview} t={t} />
      <SoundPickerRow
        label={t('sound.interrupted')}
        value={config.interruptedSound}
        onValue={(sound) => set({ interruptedSound: sound })}
        onPreview={preview}
        t={t}
      />
      <div className="sn-row">
        <span className="sn-label">{t('promptEnabled')}</span>
        <label className="sn-switch">
          <input
            type="checkbox"
            checked={config.promptEnabled}
            onChange={(event) => set({ promptEnabled: event.target.checked })}
            aria-label={t('promptEnabled')}
          />
          <span className="sn-track" aria-hidden="true" />
        </label>
      </div>
      <SoundPickerRow
        label={t('sound.prompt')}
        value={config.promptSound}
        onValue={(sound) => set({ promptSound: sound })}
        onPreview={preview}
        t={t}
      />
      <div className="sn-row">
        <span className="sn-label">{t('approvalEnabled')}</span>
        <label className="sn-switch">
          <input
            type="checkbox"
            checked={config.approvalEnabled}
            onChange={(event) => set({ approvalEnabled: event.target.checked })}
            aria-label={t('approvalEnabled')}
          />
          <span className="sn-track" aria-hidden="true" />
        </label>
      </div>
      <div className="sn-row">
        <span className="sn-label">{t('volume')}</span>
        <span className="sn-range-wrap">
          <input
            className="sn-range"
            type="range"
            min={0}
            max={100}
            step={1}
            value={Math.round(config.volume * 100)}
            onChange={(event) => set({ volume: Number(event.target.value) / 100 })}
            aria-label={t('volume')}
          />
          <span className="sn-value">{Math.round(config.volume * 100)}%</span>
        </span>
      </div>
      <div className="sn-row">
        <span className="sn-label">{t('onlySelected')}</span>
        <label className="sn-switch">
          <input
            type="checkbox"
            checked={config.onlySelected}
            onChange={(event) => set({ onlySelected: event.target.checked })}
            aria-label={t('onlySelected')}
          />
          <span className="sn-track" aria-hidden="true" />
        </label>
      </div>
      <div className="sn-row">
        <span className="sn-label">{t('includeSubagents')}</span>
        <label className="sn-switch">
          <input
            type="checkbox"
            checked={config.includeSubagents}
            onChange={(event) => set({ includeSubagents: event.target.checked })}
            aria-label={t('includeSubagents')}
          />
          <span className="sn-track" aria-hidden="true" />
        </label>
      </div>
      <div className="sn-row sn-row-last">
        <span className="sn-hint">{t('hint')}</span>
      </div>
    </div>
  )
}

function SoundPickerRow({
  label,
  value,
  onValue,
  onPreview,
  t,
}: {
  label: string
  value: SoundId
  onValue: (sound: SoundId) => void
  onPreview: (sound: SoundId) => void
  t: (key: string) => string
}) {
  return (
    <div className="sn-row">
      <span className="sn-label">{label}</span>
      <span className="sn-picker">
        <select className="sn-select" value={value} onChange={(event) => onValue(event.target.value as SoundId)} aria-label={label}>
          {SOUND_IDS.map((id) => (
            <option key={id} value={id}>
              {t(`sound.${id}`)}
            </option>
          ))}
        </select>
        <button type="button" className="sn-play" onClick={() => onPreview(value)} aria-label={t('preview')}>
          {t('preview')}
        </button>
      </span>
    </div>
  )
}

// ── localized copy ──────────────────────────────────────────────────────────

const zh = {
  nav: '音效提示',
  title: '任务完成音效',
  enabled: '启用完成音效',
  'sound.done': '完成提示音',
  'sound.interrupted': '中断提示音',
  'sound.prompt': '选择提示音',
  'sound.chime': '清脆铃声',
  'sound.ding': '叮咚',
  'sound.success': '成功和弦',
  'sound.ping': '短促提示音',
  promptEnabled: '启用选择提示音',
  approvalEnabled: '权限请求也提醒',
  volume: '音量',
  onlySelected: '仅当前会话',
  includeSubagents: '包含子任务',
  preview: '试听',
  hint: '任务自然完成播放完成音；被停止、出错或截断等中断播放中断音；弹出需要你选择的选项时播放选择提示音。设置仅对当前浏览器生效。',
}

const en = {
  nav: 'Sound Alerts',
  title: 'Task completion sound',
  enabled: 'Play sounds when a task completes',
  'sound.done': 'Completion sound',
  'sound.interrupted': 'Interruption sound',
  'sound.prompt': 'Choice prompt sound',
  'sound.chime': 'Chime',
  'sound.ding': 'Ding',
  'sound.success': 'Success chord',
  'sound.ping': 'Short ping',
  promptEnabled: 'Play a sound when the user must choose',
  approvalEnabled: 'Also play for permission approvals',
  volume: 'Volume',
  onlySelected: 'Current session only',
  includeSubagents: 'Include subtasks',
  preview: 'Play',
  hint: 'Natural completion plays the completion sound; stop, error, or truncation plays the interruption sound; user-choice prompts play the prompt sound. Settings are per-browser.',
}
