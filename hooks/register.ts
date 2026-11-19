import type { Hook, Register } from 'claude-code'

// Hands-free /clear-handoff: when the turn that armed a handoff ends with an
// answer, run /clear and start the fresh session with "Resume from <path>".
// The SessionStart command hook (clear-handoff-load.py) still injects the
// handoff; this module only removes the two keypresses around it.
//
// State lives in module memory: the launch and the /clear it runs happen in
// this one process. A reload drops it, and a manual /clear still loads the
// handoff through the sentinel.

const ARMED_MARKER = 'clear-handoff armed: '
const SENTINEL_MARKER = 'clear-handoff sentinel: '
const SENTINEL_DIR = '/.claude/tmp/pending-handoffs/'
const ARM_STEP = 'pending-handoffs'
const LAUNCH_WINDOW_MS = 2 * 60 * 1000
const MTIME_SLACK_MS = 1000
const CANCELLED = 'clear-handoff: you sent a prompt, so not clearing. Run /clear when ready; the handoff still loads.'
const BY_HAND = 'clear-handoff: not auto-clearing. Run /clear by hand; the handoff still loads.'
// Origins that carry the session owner's own words.
const PERSON_KINDS = new Set(['composer', 'bridge', 'sdk', 'slack-ping', 'channel'])

type Api = Parameters<Hook<'session.start'>>[0]
type Origin = { kind: string; name?: string }

let currentTurn: string | undefined
let turnStartedAt = 0
let armedPath: string | undefined
let armedTurn: string | undefined
let inFlight = false
let abortLaunch = false
let launching: { path: string; at: number } | undefined
let foreignClear = false
let pendingStart: string | undefined

function lastValue(text: string, marker: string): string | undefined {
  const lines = text.split('\n').filter(l => l.startsWith(marker))
  return lines.at(-1)?.slice(marker.length).trim()
}

function armedPathFrom(text: string | undefined): string | undefined {
  const path = lastValue(text ?? '', ARMED_MARKER)
  return path?.startsWith('/') && path.includes('/.tmp/') && path.endsWith('.md') ? path : undefined
}

async function freshFile($: Api, path: string): Promise<boolean> {
  const stat = await $.fs.stat(path)
  return stat.kind === 'file' && stat.size > 0 && stat.mtimeMs >= turnStartedAt - MTIME_SLACK_MS
}

// Arm only on what the loader will consume: a sentinel in the pending dir,
// written this turn, naming exactly this handoff, which was also written this
// turn. The echoed lines are the model's; the files are the proof.
async function isArmedOnDisk($: Api, path: string, text: string): Promise<boolean> {
  const sentinel = lastValue(text, SENTINEL_MARKER)
  const home = await $.env.get('HOME')
  if (!sentinel || !home || sentinel.includes('..')) return false
  if (!sentinel.startsWith(home + SENTINEL_DIR) || !sentinel.endsWith('.path')) return false
  try {
    if (!(await freshFile($, sentinel)) || !(await freshFile($, path))) return false
    return (await $.fs.read(sentinel)).trim() === path
  } catch {
    return false
  }
}

const resumeMessage = (path: string) => `Resume from ${path}`
const isPerson = (origin: Origin) => PERSON_KINDS.has(origin.kind)
const isOurs = ($: Api, origin: Origin) => origin.kind === 'plugin' && origin.name === $.plugin.name

function disarm(): void {
  armedPath = undefined
  armedTurn = undefined
}

async function clearNow($: Api, path: string): Promise<void> {
  const at = await $.clock.now()
  if (abortLaunch) {
    $.ui.toast(CANCELLED)
    return
  }
  launching = { path, at }
  try {
    await $.command.run({ command: 'clear' })
  } catch (err) {
    launching = undefined
    throw err
  }
}

// Commands reject inside a hook the turn waits on; queue from a timer so the
// /clear runs once the session is idle.
function launch($: Api, path: string): void {
  inFlight = true
  abortLaunch = false
  foreignClear = false
  disarm()
  $.clock.after(0, () => {
    clearNow($, path)
      .catch(err => $.ui.toast(`clear-handoff: auto-clear failed (${String(err)}). Run /clear; the handoff still loads.`))
      .finally(() => {
        inFlight = false
      })
  })
}

async function offerResume($: Api, text: string, reason: string): Promise<void> {
  const box = await $.prompt.read()
  const filled = box.text.trim() === '' && (await $.prompt.fill({ text })).isFilled
  $.ui.toast(
    filled
      ? `clear-handoff: could not start the resume (${reason}). Press Enter to send it.`
      : `clear-handoff: could not send "${text}" (${reason}). Send it when ready.`,
  )
}

async function startResume($: Api): Promise<void> {
  const text = pendingStart
  pendingStart = undefined
  if (text === undefined) return
  let refused: string | undefined
  try {
    refused = (await $.prompt.submit({ text, asUser: true })).drop
  } catch (err) {
    refused = String(err)
  }
  if (refused !== undefined) await offerResume($, text, refused)
}

function personSpoke($: Api): void {
  if (pendingStart !== undefined) {
    pendingStart = undefined
    $.ui.toast('clear-handoff: you typed first, so the resume prompt was not sent. The handoff is in context.')
  }
  if (armedPath) {
    disarm()
    $.ui.toast(CANCELLED)
  }
  if (inFlight || launching) abortLaunch = true
}

export const register: Register = on => {
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    if (e.agentId || !e.command.includes(ARM_STEP)) return ran
    const failed = ran.deny !== undefined || ran.isError === true
    const path = failed ? undefined : armedPathFrom(ran.text)
    if (!path || !(await isArmedOnDisk($, path, ran.text ?? ''))) {
      if (!inFlight) disarm()
      $.ui.toast(`clear-handoff: no handoff file written this turn, so nothing will auto-clear. ${BY_HAND}`)
      return ran
    }
    if (currentTurn === undefined) {
      $.ui.toast(`clear-handoff: loaded mid-turn. ${BY_HAND}`)
      return ran
    }
    armedPath = path
    armedTurn = currentTurn
    $.ui.toast('Handoff armed. This session clears when the turn ends. Send a prompt or press Esc before then to stop it.')
    return ran
  })

  on('prompt.submit', ($, e, next) => {
    if (isPerson(e.origin)) personSpoke($)
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    currentTurn = e.turnId
    turnStartedAt = await $.clock.now()
    if (armedPath && armedTurn !== e.turnId) disarm()
    if (inFlight) abortLaunch = true
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const out = await next(e)
    if (e.agentId || !armedPath || e.turnId !== armedTurn) return out
    const path = armedPath
    if (inFlight) {
      disarm()
      $.ui.toast(`clear-handoff: an earlier clear is still queued. ${BY_HAND}`)
      return out
    }
    if (e.reason !== 'answer') {
      disarm()
      $.ui.toast(`clear-handoff: turn ended (${e.reason}), so not clearing. Run /clear when ready.`)
      return out
    }
    launch($, path)
    return out
  })

  // Our own queued /clear checks abortLaunch alone: a person's /clear may have
  // already run and reset `launching`.
  on('command.run', { command: 'clear' }, async ($, e, next) => {
    if (isPerson(e.origin)) {
      disarm()
      if (inFlight || launching) abortLaunch = true
      launching = undefined
      pendingStart = undefined
      return next(e)
    }
    if (isOurs($, e.origin)) {
      if (abortLaunch) {
        launching = undefined
        $.ui.toast(CANCELLED)
        return { text: '' }
      }
      return next(e)
    }
    if (e.origin.kind === 'plugin' && launching) foreignClear = true
    return next(e)
  })

  on('classic.SessionStart', async ($, e, next) => {
    const out = await next(e)
    if (e.source !== 'clear' || !launching) return out
    if (foreignClear) {
      foreignClear = false
      return out
    }
    const { path, at } = launching
    launching = undefined
    if ((await $.clock.now()) - at > LAUNCH_WINDOW_MS) {
      $.ui.toast(`clear-handoff: the clear took too long, so the resume prompt was not sent. Paste: Resume from ${path}`)
      return out
    }
    if (abortLaunch) {
      $.ui.toast('clear-handoff: a prompt came in during the clear, so the resume prompt was not sent.')
      return out
    }
    pendingStart = resumeMessage(path)
    // initialUserMessage does not start a turn after /clear; submit once idle.
    $.clock.after(0, () => {
      startResume($).catch(err =>
        $.ui.toast(`clear-handoff: resume failed (${String(err)}). Paste: Resume from ${path}`),
      )
    })
    return out
  })
}
