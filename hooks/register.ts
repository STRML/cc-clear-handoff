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
const ARM_STEP = 'pending-handoffs'
const LAUNCH_WINDOW_MS = 2 * 60 * 1000
const CANCELLED = 'clear-handoff: you sent a prompt, so not clearing. Run /clear when ready; the handoff still loads.'
const BY_HAND = 'clear-handoff: loaded mid-turn, so not auto-clearing. Run /clear by hand; the handoff still loads.'

type Api = Parameters<Hook<'session.start'>>[0]
type Origin = { kind: string; name?: string }

let currentTurn: string | undefined
let armedPath: string | undefined
let armedTurn: string | undefined
let inFlight = false
let abortLaunch = false
let launching: { path: string; at: number } | undefined
let foreignClear = false
let pendingStart: string | undefined

function armedPathFrom(text: string | undefined): string | undefined {
  const lines = (text ?? '').split('\n').filter(l => l.startsWith(ARMED_MARKER))
  const path = lines.at(-1)?.slice(ARMED_MARKER.length).trim()
  return path?.startsWith('/') ? path : undefined
}

const resumeMessage = (path: string) => `Resume from ${path}`
const PERSON_KINDS = new Set(['composer', 'bridge', 'sdk'])
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
  if (box.text.trim() !== '') {
    $.ui.toast(`clear-handoff: could not send "${text}" (${reason}). Send it when ready.`)
    return
  }
  await $.prompt.fill({ text })
  $.ui.toast(`clear-handoff: could not start the resume (${reason}). Press Enter to send it.`)
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
    if (!path) {
      if (armedPath && !inFlight) {
        disarm()
        $.ui.toast('clear-handoff: arming failed, so nothing will auto-clear.')
      }
      return ran
    }
    if (currentTurn === undefined) {
      $.ui.toast(BY_HAND)
      return ran
    }
    armedPath = path
    armedTurn = currentTurn
    $.ui.toast('Handoff armed. When this turn ends: /clear, then resume. Type or press Esc to cancel.')
    return ran
  })

  on('prompt.submit', ($, e, next) => {
    if (isPerson(e.origin)) personSpoke($)
    return next(e)
  })

  on('turn.start', ($, e, next) => {
    if (e.agentId) return next(e)
    currentTurn = e.turnId
    if (armedPath && armedTurn !== e.turnId) disarm()
    if (inFlight) abortLaunch = true
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const out = await next(e)
    if (e.agentId || !armedPath || e.turnId !== armedTurn || inFlight) return out
    const path = armedPath
    if (e.reason !== 'answer') {
      disarm()
      $.ui.toast(`clear-handoff: turn ended (${e.reason}), so not clearing. Run /clear when ready.`)
      return out
    }
    launch($, path)
    return out
  })

  on('command.run', { command: 'clear' }, async ($, e, next) => {
    if (isPerson(e.origin)) {
      disarm()
      if (inFlight || launching) abortLaunch = true
      launching = undefined
      pendingStart = undefined
      return next(e)
    }
    if (isOurs($, e.origin)) {
      if (launching && abortLaunch) {
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
    if ((await $.clock.now()) - at > LAUNCH_WINDOW_MS) return out
    if (abortLaunch) {
      $.ui.toast('clear-handoff: a prompt came in during the clear, so the resume prompt was not sent.')
      return out
    }
    pendingStart = resumeMessage(path)
    // initialUserMessage does not start a turn after /clear; submit once idle.
    $.clock.after(0, () => {
      startResume($).catch(() => {})
    })
    return out
  })
}
