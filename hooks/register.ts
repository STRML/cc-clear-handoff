import type { Hook, Register } from 'claude-code'

// Hands-free /clear-handoff: when the turn that the person started with
// /clear-handoff (or /handoff) ends with an answer, and the handoff it wrote is
// armed exactly where the loader looks, run /clear and start the fresh session
// with "Resume from <path>". The SessionStart command hook
// (clear-handoff-load.py) still injects the handoff.
//
// Arming is verified from observed facts only, never from the model's text:
// the person's command, the Write tool's own result, and the files on disk at
// the moment of the clear. State lives in module memory; a reload drops it and
// a manual /clear still loads the handoff.

const COMMANDS = ['clear-handoff', 'handoff']
// "/handoff don't clear": save and arm, but leave the session as it is (handing
// off to another account or harness).
const NO_CLEAR = /(^|[\s,;:])(--no-clear|no[\s-]clear|don'?t[\s-]clear|do not clear)\s*([,;:.!]|$)/i
const SENTINEL_DIR = '/.claude/tmp/pending-handoffs/'
const LAUNCH_WINDOW_MS = 2 * 60 * 1000
// The loader drops sentinels older than this (clear-handoff-load.py TTL).
const SENTINEL_TTL_MS = 24 * 60 * 60 * 1000
// Filesystems that keep whole-second mtimes round a fresh write down.
const MTIME_SLACK_MS = 1000
const CANCELLED = 'clear-handoff: something new came in (your prompt, a /clear, or a notification turn), so not clearing. Run /clear when ready.'
const BY_HAND = 'Run /clear by hand when ready.'
const REARM = 'Run /clear-handoff again to save and arm it.'
const CLEAR_NOW = 'Clear and resume now'
const WAIT = 'Wait'
// Origins that carry the session owner's own words.
const PERSON_KINDS = new Set(['composer', 'bridge', 'sdk', 'slack-ping', 'channel'])

type Api = Parameters<Hook<'session.start'>>[0]
type Origin = { kind: string; name?: string }

let intentPending = false
let submitSeq = 0
let sawTurnStart = false
let strayHandoffWrite = false
let intentTurn: string | undefined
let intentStartedAt = 0
let writtenPath: string | undefined
let inFlight = false
let abortLaunch = false
let launching: { path: string; at: number } | undefined
let foreignClear = false
let pendingStart: string | undefined

const isPerson = (origin: Origin) => PERSON_KINDS.has(origin.kind)
const isOurs = ($: Api, origin: Origin) => origin.kind === 'plugin' && origin.name === $.plugin.name
const isHandoffCommand = ($: Api, name: string) =>
  COMMANDS.some(c => name === c || name === `${$.plugin.name}:${c}`)

// A file directly inside a `.tmp` directory, absolute, no `..` segment.
function isHandoffPath(path: string | undefined): path is string {
  if (!path || !path.startsWith('/') || !path.endsWith('.md')) return false
  const parts = path.split('/')
  return !parts.includes('..') && parts.at(-2) === '.tmp'
}

// The sentinel name the loader tries first: realpath(session cwd) with every
// `/` and `.` turned into `-`, outer dashes stripped (clear-handoff-load.py).
async function sentinelPath($: Api): Promise<string | undefined> {
  const home = await $.env.get('HOME')
  const cwd = await $.session.cwd()
  const real = (await $.fs.stat(cwd, { resolve: true })).realPath ?? cwd
  if (!home) return undefined
  return `${home}${SENTINEL_DIR}${real.replace(/[/.]/g, '-').replace(/^-+|-+$/g, '')}.path`
}

// What the loader will inject after the clear: the sentinel for this session,
// rewritten this turn and not yet expired, naming this handoff, which reads
// back with content.
async function armedOnDisk($: Api, path: string): Promise<boolean> {
  try {
    const sentinel = await sentinelPath($)
    if (!sentinel) return false
    const mark = await $.fs.stat(sentinel)
    const now = await $.clock.now()
    if (mark.kind !== 'file' || mark.mtimeMs < intentStartedAt - MTIME_SLACK_MS) return false
    if (now - mark.mtimeMs > SENTINEL_TTL_MS) return false
    if ((await $.fs.read(sentinel)).trim() !== path) return false
    return (await $.fs.read(path)).trim() !== ''
  } catch {
    return false
  }
}

function forgetIntent(): void {
  intentPending = false
  intentTurn = undefined
  writtenPath = undefined
}

// The person decides each time; a dismissed dialog, or a -p run with no one
// to ask, means wait.
async function wantsClearNow($: Api): Promise<boolean> {
  try {
    const answer = await $.ui.ask('Clear this session and resume from the handoff now?', {
      header: 'Handoff',
      options: [CLEAR_NOW, WAIT],
    })
    return answer === CLEAR_NOW
  } catch {
    return false
  }
}

async function clearNow($: Api, path: string): Promise<void> {
  if (!(await wantsClearNow($))) {
    $.ui.toast(`clear-handoff: not clearing. ${BY_HAND}`)
    return
  }
  // The dialog has no timeout: the sentinel may have been consumed or expired
  // while it was open.
  if (!(await armedOnDisk($, path))) {
    $.ui.toast(`clear-handoff: the handoff is no longer armed, so not clearing. ${REARM}`)
    return
  }
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
// /clear runs once the session is idle. The caller set inFlight already.
function launch($: Api, path: string): void {
  foreignClear = false
  $.clock.after(0, () => {
    clearNow($, path)
      .catch(err => $.ui.toast(`clear-handoff: auto-clear failed (${String(err)}). ${BY_HAND}`))
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
  if (text === undefined) return
  const draft = (await $.prompt.read()).text.trim()
  // A person's prompt during the read cancels by clearing pendingStart.
  if (pendingStart !== text) return
  pendingStart = undefined
  if (draft !== '') {
    $.ui.toast(`clear-handoff: you have a draft, so the resume prompt was not sent. The handoff is in context; send "${text}" when ready.`)
    return
  }
  let refused: string | undefined
  try {
    refused = (await $.prompt.submit({ text, asUser: true })).drop
  } catch (err) {
    refused = String(err)
  }
  if (refused !== undefined) await offerResume($, text, refused)
}

function personSpoke($: Api, startsHandoff: boolean): void {
  if (pendingStart !== undefined) {
    pendingStart = undefined
    $.ui.toast('clear-handoff: you typed first, so the resume prompt was not sent. The handoff is in context.')
  }
  if (intentTurn !== undefined) {
    forgetIntent()
    $.ui.toast(CANCELLED)
  }
  if (inFlight || launching) abortLaunch = true
  intentPending = startsHandoff
}

export const register: Register = on => {
  on('prompt.submit', async ($, e, next) => {
    if (!isPerson(e.origin)) return next(e)
    const startsHandoff = !!e.command && isHandoffCommand($, e.command.name) && !NO_CLEAR.test(e.command.args)
    const seq = ++submitSeq
    // Set intent before next(): the engine raises this submission's turn.start
    // inside the chain, before next() resolves. A dropped submission starts no
    // turn, so its intent is withdrawn afterwards.
    personSpoke($, startsHandoff)
    const out = await next(e)
    if (out.drop !== undefined && seq === submitSeq) intentPending = false
    return out
  })

  on('turn.start', async ($, e, next) => {
    sawTurnStart = true
    strayHandoffWrite = false
    if (intentPending) {
      intentPending = false
      intentTurn = e.turnId
      intentStartedAt = await $.clock.now()
      writtenPath = undefined
    } else if (intentTurn !== e.turnId) {
      forgetIntent()
    }
    if (inFlight) abortLaunch = true
    return next(e)
  })

  on('tool.call', { tool: 'Write' }, async ($, e, next) => {
    const ran = await next(e)
    if (e.agentId || !isHandoffPath(e.file_path)) return ran
    if (!sawTurnStart) strayHandoffWrite = true
    if (intentTurn === undefined) return ran
    const ok = ran.deny === undefined && ran.isError !== true
    if (ok) writtenPath = e.file_path
    else if (writtenPath === e.file_path) writtenPath = undefined
    return ran
  })

  on('turn.complete', async ($, e, next) => {
    const out = await next(e)
    if (e.agentId) return out
    if (strayHandoffWrite) {
      strayHandoffWrite = false
      $.ui.toast(`clear-handoff: the plugin reloaded mid-turn, so it will not clear by itself. ${BY_HAND}`)
    }
    if (intentTurn === undefined || e.turnId !== intentTurn) return out
    const path = writtenPath
    forgetIntent()
    if (inFlight) {
      $.ui.toast(`clear-handoff: an earlier clear is still queued. ${BY_HAND}`)
      return out
    }
    if (e.reason !== 'answer') {
      $.ui.toast(`clear-handoff: turn ended (${e.reason}), so not clearing. ${BY_HAND}`)
      return out
    }
    // Hold the launch slot while validating, so a prompt or /clear that lands
    // during the disk checks cancels it.
    inFlight = true
    abortLaunch = false
    const armed = !!path && (await armedOnDisk($, path))
    if (!armed || abortLaunch) {
      inFlight = false
      $.ui.toast(abortLaunch ? CANCELLED : `clear-handoff: the handoff is not armed for this session, so not clearing. ${REARM}`)
      return out
    }
    launch($, path)
    return out
  })

  // Our own queued /clear checks abortLaunch alone: a person's /clear may have
  // already run and reset `launching`.
  on('command.run', { command: 'clear' }, async ($, e, next) => {
    if (isPerson(e.origin)) {
      forgetIntent()
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
    pendingStart = `Resume from ${path}`
    // initialUserMessage does not start a turn after /clear; submit once idle.
    $.clock.after(0, () => {
      startResume($).catch(err =>
        $.ui.toast(`clear-handoff: resume failed (${String(err)}). Paste: Resume from ${path}`),
      )
    })
    return out
  })
}
