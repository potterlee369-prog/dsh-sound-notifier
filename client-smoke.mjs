// Client-bundle shape + behavior test (dev-only): loads lib/client.js the way
// the web shell does (classic script + __ModuleLoader__ handoff), checks the
// factory exports, then drives a fake `sessions.list` through running→idle
// edges and asserts the classification — natural completion vs interruption —
// reaches the cross-tab claim protocol with the right kind.
import { readFileSync } from 'node:fs'

let handoff = null
globalThis.window = {
  __ModuleLoader__: { load(h) { handoff = h } },
  addEventListener() {},
  removeEventListener() {},
  setTimeout,
}
// Node 24 ships a real BroadcastChannel (a dangling event-loop handle);
// stub it to record claims instead.
const claims = []
globalThis.BroadcastChannel = class {
  addEventListener() {}
  removeEventListener() {}
  postMessage(message) {
    claims.push(message)
  }
  close() {}
}
// Stub the Web Audio API so the full play path runs without a device.
globalThis.window.AudioContext = class {
  state = 'running'
  currentTime = 0
  destination = {}
  resume() {
    return Promise.resolve()
  }
  createOscillator() {
    return { type: '', frequency: { value: 0 }, connect() {}, start() {}, stop() {} }
  }
  createGain() {
    return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {}, value: 0 }, connect() {} }
  }
}

// eslint-disable-next-line no-eval
;(0, eval)(readFileSync(new URL('./lib/client.js', import.meta.url), 'utf8'))

if (handoff === null) throw new Error('bundle never called __ModuleLoader__.load')
if (handoff.id !== 'dsh-sound-notifier') throw new Error(`unexpected factory id: ${handoff.id}`)

const reactMock = {
  useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(),
}
const jsxMock = { jsx: (...args) => args, jsxs: (...args) => args }

const plugin = handoff.factory((spec) => {
  if (spec === 'react') return reactMock
  if (spec === 'react/jsx-runtime') return jsxMock
  throw new Error(`unexpected require: ${spec}`)
})

console.log('factory id:', handoff.id)
console.log('exports:', Object.keys(plugin))
console.log('inject:', plugin.inject)
if (typeof plugin.apply !== 'function') throw new Error('apply is not a function')

// Fake client context with a session instance cluster.
const sessionInstances = new Map()
let sessionRows = {}
let listListener = null
const listStore = {
  subscribe(listener) {
    listListener = listener
    return () => {
      listListener = null
    }
  },
  getSnapshot() {
    const ids = Object.keys(sessionRows)
    const byId = { ...sessionRows }
    return { ids, byId, current: 's1', phase: 'ready' }
  },
}
const registrations = []
const disposers = []
const ctx = {
  sessions: {
    list: listStore,
    manager: { sessions: sessionInstances },
  },
  slots: {
    inject(name, register) {
      register()
    },
    register(options, component) {
      registrations.push({ options, component })
    },
  },
  locale: {
    register() {
      return () => {}
    },
    bind: () => (key) => key,
  },
  effect(callback, label) {
    disposers.push({ label, dispose: callback() })
    return label
  },
}

plugin.apply(ctx)
if (listListener === null) throw new Error('watcher did not subscribe to sessions.list')
console.log('effects installed:', disposers.map((d) => d.label).join(', '))

const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms))
const turnEnd = (kind) => ({ type: 'turn/end', seq: 100, data: { reason: { kind } } })
const setRunning = (id, running, extra = {}) => {
  sessionRows = { [id]: { id, running, origin: undefined, ...extra } }
  listListener()
}
const waitForClaim = async () => {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (claims.length > 0) return claims.shift()
    await sleep(25)
  }
  throw new Error('no claim posted within the window')
}

// First observation just records the running bit.
setRunning('s1', false)
await sleep(20)
if (claims.length !== 0) throw new Error('idle first observation must not play')

// Natural completion of the current session: turn/end completed → done.
setRunning('s1', true)
sessionInstances.set('s1', { events: [turnEnd('completed')] })
setRunning('s1', false)
let claim = await waitForClaim()
console.log('natural completion claim:', JSON.stringify(claim))
if (claim.kind !== 'done') throw new Error(`expected done, got ${claim.kind}`)

// Interruption of the current session: turn/end aborted → interrupted.
await sleep(1100)
setRunning('s1', true)
sessionInstances.set('s1', { events: [turnEnd('aborted')] })
setRunning('s1', false)
claim = await waitForClaim()
console.log('interruption claim:', JSON.stringify(claim))
if (claim.kind !== 'interrupted') throw new Error(`expected interrupted, got ${claim.kind}`)

// Error termination also classifies as interrupted.
await sleep(1100)
setRunning('s1', true)
sessionInstances.set('s1', { events: [turnEnd('error')] })
setRunning('s1', false)
claim = await waitForClaim()
console.log('error claim:', JSON.stringify(claim))
if (claim.kind !== 'interrupted') throw new Error(`expected interrupted for error, got ${claim.kind}`)

// A background session (not current) falls back to done even with an error
// turn/end in its (stale) window.
await sleep(1100)
sessionRows = { s1: { id: 's1', running: false, origin: undefined }, s2: { id: 's2', running: true, origin: undefined } }
sessionInstances.set('s2', { events: [turnEnd('error')] })
listListener()
sessionRows = { s1: { id: 's1', running: false, origin: undefined }, s2: { id: 's2', running: false, origin: undefined } }
listListener()
claim = await waitForClaim()
console.log('background session claim:', JSON.stringify(claim))
if (claim.kind !== 'done') throw new Error(`expected done for background session, got ${claim.kind}`)

// Subagent edge is gated by config (default: skip).
await sleep(1100)
sessionRows = { s3: { id: 's3', running: true, origin: 'subagent' } }
listListener()
sessionRows = { s3: { id: 's3', running: false, origin: 'subagent' } }
listListener()
await sleep(120)
if (claims.length !== 0) throw new Error('subagent edge must be gated off by default')

// User-choice prompt: a pending question appears → question claim.
sessionRows = { s3: { id: 's3', running: true, origin: 'subagent', pendingInteraction: 'question' } }
listListener()
claim = await waitForClaim()
console.log('question prompt claim:', JSON.stringify(claim))
if (claim.kind !== 'question') throw new Error(`expected question prompt, got ${claim.kind}`)

// Resolving the prompt must not play a second sound.
sessionRows = { s3: { id: 's3', running: true, origin: 'subagent' } }
listListener()
await sleep(20)
if (claims.length !== 0) throw new Error('resolving a prompt must not play')

// Plan-review is also a user-choice prompt (question sound, after cooldown).
await sleep(1100)
sessionRows = { s3: { id: 's3', running: true, origin: 'subagent', pendingInteraction: 'plan-review' } }
listListener()
claim = await waitForClaim()
console.log('plan-review prompt claim:', JSON.stringify(claim))
if (claim.kind !== 'question') throw new Error(`expected plan-review as question, got ${claim.kind}`)

// Permission-approval is opt-in; the default config must not ring.
await sleep(1100)
sessionRows = { s3: { id: 's3', running: true, origin: 'subagent', pendingInteraction: 'approval' } }
listListener()
await sleep(120)
if (claims.length !== 0) throw new Error('approval prompt must be gated off by default')

// A session first observed with an already-pending question must not replay it.
sessionRows = { s4: { id: 's4', running: true, origin: undefined, pendingInteraction: 'question' } }
listListener()
await sleep(120)
if (claims.length !== 0) throw new Error('first observation of a pending question must not play')

console.log('slot registrations:', registrations.map((r) => `${r.options.name}:${r.options.id ?? ''}`).join(', '))
console.log('smoke ok')
