import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const NOW = 1_000_000
const HOME = '/Users/t'
const CWD = '/Users/t/repo'
const PATH = `${CWD}/.tmp/auto-clear-resume-20261119-010000.md`
const SENTINEL = `${HOME}/.claude/tmp/pending-handoffs/Users-t-repo.path`

// The engine beneath the mod: a clock, a Write tool, a file system holding
// the handoff and the sentinel, slash commands we record, a prompt box, and
// the prompts our mod submits.
function world(on: On, opts: { box?: string; nestTurnStart?: any } = {}) {
  const ran: string[] = []
  const filled: string[] = []
  const submitted: string[] = []
  const toasts: string[] = []
  const write = { fails: false, denied: false }
  const disk = {
    handoffSize: 900,
    handoffMissing: false,
    sentinelText: PATH,
    sentinelMtime: NOW + 1,
    sentinelMissing: false,
  }
  const refuse = { plugin: undefined as string | undefined, person: undefined as string | undefined }
  const clear = { rejects: false }
  const box = { fills: true }
  const clock = mock.clock(on, { now: NOW })
  on('session.id', () => ({ value: 'plan-1' }))
  on('session.cwd', () => ({ value: CWD }))
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? HOME : undefined })) as never
  on('fs.stat', (_, e) => {
    const path = (e as { path: string }).path
    if (path === CWD) return { value: { kind: 'dir', size: 0, mtimeMs: 0, isLink: false, realPath: CWD } }
    const isSentinel = path === SENTINEL
    if (isSentinel ? disk.sentinelMissing : disk.handoffMissing) throw new Error('ENOENT')
    return {
      value: isSentinel
        ? { kind: 'file', size: 60, mtimeMs: disk.sentinelMtime, isLink: false }
        : { kind: 'file', size: disk.handoffSize, mtimeMs: NOW + 1, isLink: false },
    }
  }) as never
  on('fs.read', (_, e) => {
    if ((e as { path: string }).path === SENTINEL) {
      if (disk.sentinelMissing) throw new Error('ENOENT')
      return { value: disk.sentinelText }
    }
    if (disk.handoffMissing) throw new Error('ENOENT')
    return { value: disk.handoffSize > 0 ? '# Handoff' : '' }
  }) as never
  on('prompt.read', () => ({ value: { text: opts.box ?? '', cursor: 0 } }))
  on('prompt.fill', (_, e) => {
    if (!box.fills) return { isFilled: false }
    filled.push(e.text)
    return { isFilled: true }
  })
  on('ui.toast', (_, e) => {
    toasts.push(String((e as { text?: string }).text ?? e))
    return { value: undefined }
  })
  on('tool.call', () => {
    if (write.denied) return { deny: 'not allowed' }
    return write.fails ? { result: {}, text: 'EACCES', isError: true } : { result: {}, text: 'ok' }
  })
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('prompt.submit', async (_, e) => {
    // The engine raises turn.start before the submission's chain resolves.
    if (opts.nestTurnStart && e.command) await opts.nestTurnStart.turn.start({ text: e.text, turnId: 't1' })
    if (e.origin.kind === 'plugin') {
      if (refuse.plugin) return { drop: refuse.plugin }
      submitted.push(e.text)
    }
    if (e.origin.kind === 'composer' && refuse.person) return { drop: refuse.person }
    return { text: e.text }
  })
  on('command.run', (_, e) => {
    if (clear.rejects) throw new Error('busy')
    ran.push(e.command)
    return { text: '' }
  })
  on('classic.SessionStart', () => ({}))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  return { ran, filled, submitted, toasts, write, disk, refuse, clear, box, clock }
}

type W = ReturnType<typeof world>

const ended = (reason: 'answer' | 'aborted' | 'error' | 'refusal' = 'answer', turnId = 't1', agentId?: string): never =>
  ({
    answer: 'Handoff saved',
    durationMs: 10,
    isAborted: reason === 'aborted',
    turnId,
    reason,
    ...(agentId ? { agentId } : {}),
  }) as never

const handoffCommand = (name = 'clear-handoff') => ({
  text: `/${name} build it`,
  wait: false,
  origin: { kind: 'composer' as const },
  command: { name, args: 'build it' },
})

const person = (turnId?: string) => ({
  text: 'wait, one more thing',
  wait: false,
  origin: { kind: 'composer' as const },
  ...(turnId ? { turnId } : {}),
})

const notification = (turnId?: string) => ({
  text: '<task-notification>done</task-notification>',
  wait: false,
  origin: { kind: 'task-notification' as const },
  ...(turnId ? { turnId } : {}),
})

const slackPing = () => ({ text: 'stop', wait: false, origin: { kind: 'slack-ping' as const } })

const presentation = { isFullscreen: false, columns: 120 }
const typedClear = { command: 'clear', args: '', origin: { kind: 'composer' as const }, presentation }
const otherPluginClear = { command: 'clear', args: '', origin: { kind: 'plugin' as const, name: 'someone-else' }, presentation }

const writeHandoff = ($: any, file_path = PATH, agentId?: string) =>
  $.tool.call({ tool: 'Write', file_path, content: '# Handoff', ...(agentId ? { agentId } : {}) } as never)

const opened = ($: any, source = 'clear') => $.classic.SessionStart({ source, session_id: 'fresh-1' } as never)

const settle = (w: W) => w.clock.settle()

// The person types /clear-handoff; the turn writes the handoff.
async function handoffTurn($: any, path = PATH, turnId = 't1') {
  await $.prompt.submit(handoffCommand())
  await $.turn.start({ text: '/clear-handoff', turnId })
  await writeHandoff($, path)
}

// Happy path up to the fresh session's resume.
async function launched($: any, w: W) {
  await handoffTurn($)
  await $.turn.complete(ended())
  await settle(w)
  await opened($)
  await settle(w)
}

// Arming (redesign matrix A1-A15)

test('A1: /clear-handoff, Write ok, sentinel names it: one /clear, then Resume from <path>', async ($, on) => {
  const w = world(on)
  await launched($, w)
  expect(w.ran).toEqual(['clear'])
  expect(w.submitted).toEqual([`Resume from ${PATH}`])
})

test('A1b: the /handoff alias arms the same way', async ($, on) => {
  const w = world(on)
  await $.prompt.submit(handoffCommand('handoff'))
  await $.turn.start({ text: '/handoff', turnId: 't1' })
  await writeHandoff($)
  await $.turn.complete(ended())
  await settle(w)
  expect(w.ran).toEqual(['clear'])
})

test('A2: a turn the person did not start with /clear-handoff never clears', async ($, on) => {
  const w = world(on)
  await $.prompt.submit(person())
  await $.turn.start({ text: 'x', turnId: 't1' })
  await writeHandoff($)
  await $.turn.complete(ended())
  await settle(w)
  expect(w.ran).toEqual([])
})

test('A2b: /clear-handoff with no Write this turn does not clear, and says so', async ($, on) => {
  const w = world(on)
  await $.prompt.submit(handoffCommand())
  await $.turn.start({ text: '/clear-handoff', turnId: 't1' })
  await $.turn.complete(ended())
  await settle(w)
  expect(w.ran).toEqual([])
  expect(w.toasts.some(t => t.includes('Run /clear-handoff again'))).toBe(true)
})

for (const how of ['fails', 'denied'] as const) {
  test(`A3: a Write that ${how} does not arm`, async ($, on) => {
    const w = world(on)
    w.write[how] = true
    await handoffTurn($)
    await $.turn.complete(ended())
    await settle(w)
    expect(w.ran).toEqual([])
  })
}

test('A4: a handoff written in an earlier turn does not count', async ($, on) => {
  const w = world(on)
  await $.turn.start({ text: 'write', turnId: 't0' })
  await writeHandoff($)
  await $.turn.complete(ended('answer', 't0'))
  await $.prompt.submit(handoffCommand())
  await $.turn.start({ text: '/clear-handoff', turnId: 't1' })
  await $.turn.complete(ended())
  await settle(w)
  expect(w.ran).toEqual([])
})

test("A5: a subagent's Write does not count", async ($, on) => {
  const w = world(on)
  await $.prompt.submit(handoffCommand())
  await $.turn.start({ text: '/clear-handoff', turnId: 't1' })
  await writeHandoff($, PATH, 'a1')
  await $.turn.complete(ended())
  await settle(w)
  expect(w.ran).toEqual([])
})

test('A6: a failed Write after a good one disarms', async ($, on) => {
  const w = world(on)
  await handoffTurn($)
  w.write.fails = true
  await writeHandoff($)
  await $.turn.complete(ended())
  await settle(w)
  expect(w.ran).toEqual([])
})

test('A7: no sentinel on disk does not clear', async ($, on) => {
  const w = world(on)
  w.disk.sentinelMissing = true
  await handoffTurn($)
  await $.turn.complete(ended())
  await settle(w)
  expect(w.ran).toEqual([])
})

test('A8: a sentinel left from before this turn does not clear', async ($, on) => {
  const w = world(on)
  w.disk.sentinelMtime = NOW - 60_000
  await handoffTurn($)
  await $.turn.complete(ended())
  await settle(w)
  expect(w.ran).toEqual([])
})

test('A11: a sentinel naming a different handoff does not clear', async ($, on) => {
  const w = world(on)
  w.disk.sentinelText = `${CWD}/.tmp/other.md`
  await handoffTurn($)
  await $.turn.complete(ended())
  await settle(w)
  expect(w.ran).toEqual([])
})

test('A12: an empty handoff file does not clear', async ($, on) => {
  const w = world(on)
  w.disk.handoffSize = 0
  await handoffTurn($)
  await $.turn.complete(ended())
  await settle(w)
  expect(w.ran).toEqual([])
})

test('A13: a handoff deleted before the turn ends does not clear', async ($, on) => {
  const w = world(on)
  await handoffTurn($)
  w.disk.handoffMissing = true
  await $.turn.complete(ended())
  await settle(w)
  expect(w.ran).toEqual([])
})

test('A14: a path with spaces resumes with the full path', async ($, on) => {
  const w = world(on)
  const spaced = `${CWD}/.tmp/a b.md`
  w.disk.sentinelText = spaced
  await handoffTurn($, spaced)
  await $.turn.complete(ended())
  await settle(w)
  await opened($)
  await settle(w)
  expect(w.submitted).toEqual([`Resume from ${spaced}`])
})

for (const bad of [`${CWD}/README.md`, `${CWD}/.tmp/../README.md`, `${CWD}/.tmp/sub/x.md`, '.tmp/x.md', `${CWD}/.tmp/x.txt`]) {
  test(`A15: a Write to ${bad} never arms`, async ($, on) => {
    const w = world(on)
    w.disk.sentinelText = bad
    await handoffTurn($, bad)
    await $.turn.complete(ended())
    await settle(w)
    expect(w.ran).toEqual([])
  })
}

// Turn end

for (const reason of ['aborted', 'error', 'refusal'] as const) {
  test(`9: a turn that ends ${reason} does not clear`, async ($, on) => {
    const w = world(on)
    await handoffTurn($)
    await $.turn.complete(ended(reason))
    await settle(w)
    expect(w.ran).toEqual([])
    expect(w.toasts.some(t => t.includes('by hand'))).toBe(true)
  })
}

test('26: an intent from an earlier turn lapses when another turn starts', async ($, on) => {
  const w = world(on)
  await handoffTurn($)
  await $.turn.start({ text: 'x', turnId: 't2' })
  await $.turn.complete(ended())
  await $.turn.complete(ended('answer', 't2'))
  await settle(w)
  expect(w.ran).toEqual([])
})

// Cancellation

for (const turnId of ['t1', undefined]) {
  test(`11: a person's prompt during the handoff turn (turnId ${turnId}) cancels`, async ($, on) => {
    const w = world(on)
    await handoffTurn($)
    await $.prompt.submit(person(turnId))
    await $.turn.complete(ended())
    await settle(w)
    expect(w.ran).toEqual([])
  })
}

test('12: a task notification during the handoff turn does not cancel', async ($, on) => {
  const w = world(on)
  await handoffTurn($)
  await $.prompt.submit(notification('t1'))
  await $.turn.complete(ended())
  await settle(w)
  expect(w.ran).toEqual(['clear'])
})

test('12b: an owner Slack ping during the handoff turn cancels', async ($, on) => {
  const w = world(on)
  await handoffTurn($)
  await $.prompt.submit(slackPing())
  await $.turn.complete(ended())
  await settle(w)
  expect(w.ran).toEqual([])
})

test('13: a person prompt after the turn, before the /clear runs, drops it', async ($, on) => {
  const w = world(on)
  await handoffTurn($)
  await $.turn.complete(ended())
  await $.prompt.submit(person())
  await settle(w)
  expect(w.ran).toEqual([])
})

test('14: a new main-loop turn while the /clear is queued drops it', async ($, on) => {
  const w = world(on)
  await handoffTurn($)
  await $.turn.complete(ended())
  await $.turn.start({ text: 'notified', turnId: 't2' })
  await settle(w)
  expect(w.ran).toEqual([])
})

test("15: a person's /clear during the handoff turn stands the mod down", async ($, on) => {
  const w = world(on)
  await handoffTurn($)
  await $.command.run(typedClear)
  await opened($)
  await $.turn.complete(ended())
  await settle(w)
  expect(w.ran).toEqual(['clear'])
  expect(w.submitted).toEqual([])
})

test("16: a person's /clear while the launch is in flight runs exactly one /clear", async ($, on) => {
  const w = world(on)
  await handoffTurn($)
  await $.turn.complete(ended())
  await $.command.run(typedClear)
  await settle(w)
  await opened($)
  await settle(w)
  expect(w.ran).toEqual(['clear'])
  expect(w.submitted).toEqual([])
})

test('16c: a second handoff turn while a clear is still queued says to clear by hand', async ($, on) => {
  const w = world(on)
  await handoffTurn($)
  await $.turn.complete(ended())
  await handoffTurn($, PATH, 't2')
  await $.turn.complete(ended('answer', 't2'))
  expect(w.toasts.some(t => t.includes('earlier clear is still queued'))).toBe(true)
  await settle(w)
  expect(w.ran).toEqual([])
})

test("17: another plugin's /clear while ours is queued does not take our SessionStart", async ($, on) => {
  const w = world(on)
  await handoffTurn($)
  await $.turn.complete(ended())
  await settle(w)
  await $.command.run(otherPluginClear)
  await opened($)
  await settle(w)
  expect(w.submitted).toEqual([])
  await opened($)
  await settle(w)
  expect(w.submitted).toEqual([`Resume from ${PATH}`])
})

for (const source of ['startup', 'compact', 'resume']) {
  test(`18: a ${source} SessionStart while launching does not submit`, async ($, on) => {
    const w = world(on)
    await handoffTurn($)
    await $.turn.complete(ended())
    await settle(w)
    await opened($, source)
    await settle(w)
    expect(w.submitted).toEqual([])
  })
}

test('19: an abort that reaches SessionStart after our /clear ran does not submit', async ($, on) => {
  const w = world(on)
  await handoffTurn($)
  await $.turn.complete(ended())
  await settle(w)
  await $.prompt.submit(person())
  await opened($)
  await settle(w)
  expect(w.submitted).toEqual([])
  expect(w.toasts.some(t => t.includes('not sent'))).toBe(true)
})

test('20: a SessionStart over 2 minutes late does not submit, and says what to paste', async ($, on) => {
  const w = world(on)
  await handoffTurn($)
  await $.turn.complete(ended())
  await settle(w)
  await w.clock.advance(3 * 60 * 1000)
  await opened($)
  await settle(w)
  expect(w.submitted).toEqual([])
  expect(w.toasts.some(t => t.includes(`Paste: Resume from ${PATH}`))).toBe(true)
})

// Fresh session

test('21: a person typing first in the fresh session skips our submit', async ($, on) => {
  const w = world(on)
  await handoffTurn($)
  await $.turn.complete(ended())
  await settle(w)
  await opened($)
  await $.prompt.submit(person())
  await settle(w)
  expect(w.submitted).toEqual([])
})

test('22: a task notification in the fresh session does not skip our submit', async ($, on) => {
  const w = world(on)
  await handoffTurn($)
  await $.turn.complete(ended())
  await settle(w)
  await opened($)
  await $.prompt.submit(notification())
  await settle(w)
  expect(w.submitted).toEqual([`Resume from ${PATH}`])
})

test('23: a refused submit with an empty box fills the box', async ($, on) => {
  const w = world(on)
  w.refuse.plugin = 'a Stop stands'
  await launched($, w)
  expect(w.filled).toEqual([`Resume from ${PATH}`])
  expect(w.toasts.some(t => t.includes('Enter'))).toBe(true)
})

test('24: a refused submit with text in the box leaves it and names the prompt', async ($, on) => {
  const w = world(on, { box: 'draft' })
  w.refuse.plugin = 'a Stop stands'
  await launched($, w)
  expect(w.filled).toEqual([])
  expect(w.toasts.some(t => t.includes(`Resume from ${PATH}`))).toBe(true)
})

test('24b: a refused submit where the box cannot take text does not say press Enter', async ($, on) => {
  const w = world(on)
  w.refuse.plugin = 'a Stop stands'
  w.box.fills = false
  await launched($, w)
  expect(w.toasts.some(t => t.includes('Enter'))).toBe(false)
  expect(w.toasts.some(t => t.includes(`Resume from ${PATH}`))).toBe(true)
})

test('25: a rejected /clear toasts, and a later handoff turn still works', async ($, on) => {
  const w = world(on)
  w.clear.rejects = true
  await handoffTurn($)
  await $.turn.complete(ended())
  await settle(w)
  expect(w.toasts.some(t => t.includes('auto-clear failed'))).toBe(true)
  w.clear.rejects = false
  await handoffTurn($, PATH, 't2')
  await $.turn.complete(ended('answer', 't2'))
  await settle(w)
  expect(w.ran).toEqual(['clear'])
})

// Round 5

test('R5-3: another plugin\'s /x:handoff never authorizes a clear', async ($, on) => {
  const w = world(on)
  await $.prompt.submit(handoffCommand('other-plugin:handoff'))
  await $.turn.start({ text: '/other-plugin:handoff', turnId: 't1' })
  await writeHandoff($)
  await $.turn.complete(ended())
  await settle(w)
  expect(w.ran).toEqual([])
})

test('R5-4: a dropped /clear-handoff does not arm the next turn', async ($, on) => {
  const w = world(on)
  w.refuse.person = 'blocked'
  await $.prompt.submit(handoffCommand())
  w.refuse.person = undefined
  await $.prompt.submit(person())
  await $.turn.start({ text: 'x', turnId: 't1' })
  await writeHandoff($)
  await $.turn.complete(ended())
  await settle(w)
  expect(w.ran).toEqual([])
})

test('R5-6: a draft in the fresh session box stops the resume prompt', async ($, on) => {
  const w = world(on, { box: 'half-typed thought' })
  await launched($, w)
  expect(w.ran).toEqual(['clear'])
  expect(w.submitted).toEqual([])
  expect(w.toasts.some(t => t.includes('you have a draft'))).toBe(true)
})

test('R5-9: a sentinel older than the loader TTL does not clear', async ($, on) => {
  const w = world(on)
  await handoffTurn($)
  await w.clock.advance(25 * 60 * 60 * 1000)
  await $.turn.complete(ended())
  await settle(w)
  expect(w.ran).toEqual([])
})

test('R5-10: a sentinel mtime rounded down to the second still counts', async ($, on) => {
  const w = world(on)
  w.disk.sentinelMtime = NOW - 500
  await handoffTurn($)
  await $.turn.complete(ended())
  await settle(w)
  expect(w.ran).toEqual(['clear'])
})

test('R5-8: a handoff Write in a turn whose start the mod never saw says to clear by hand', async ($, on) => {
  const w = world(on)
  await writeHandoff($)
  await $.turn.complete(ended())
  await settle(w)
  expect(w.ran).toEqual([])
  expect(w.toasts.some(t => t.includes('reloaded mid-turn'))).toBe(true)
})

test('R6-3: a newer person prompt wins over a slow /clear-handoff submit', async ($, on) => {
  const w = world(on)
  const slow = $.prompt.submit(handoffCommand())
  await $.prompt.submit(person())
  await slow
  await $.turn.start({ text: 'x', turnId: 't1' })
  await writeHandoff($)
  await $.turn.complete(ended())
  await settle(w)
  expect(w.ran).toEqual([])
})

test('L1: turn.start raised inside the submit chain (as the engine does) still arms', async ($, on) => {
  const w = world(on, { nestTurnStart: $ })
  await $.prompt.submit(handoffCommand('cc-clear-handoff:handoff'))
  await writeHandoff($)
  await $.turn.complete(ended())
  await settle(w)
  expect(w.ran).toEqual(['clear'])
})

for (const args of ["don't clear", 'do not clear, build it', '--no-clear', 'no clear: switching accounts', "build it, don't clear"]) {
  test(`N1: "/handoff ${args}" saves the handoff but never clears`, async ($, on) => {
    const w = world(on)
    await $.prompt.submit({ ...handoffCommand('handoff'), text: `/handoff ${args}`, command: { name: 'handoff', args } })
    await $.turn.start({ text: '/handoff', turnId: 't1' })
    await writeHandoff($)
    await $.turn.complete(ended())
    await settle(w)
    expect(w.ran).toEqual([])
  })
}

test('N2: a directive that merely mentions clearing still clears', async ($, on) => {
  const w = world(on)
  await $.prompt.submit({ ...handoffCommand(), command: { name: 'clear-handoff', args: 'clear the old cache files' } })
  await $.turn.start({ text: '/clear-handoff', turnId: 't1' })
  await writeHandoff($)
  await $.turn.complete(ended())
  await settle(w)
  expect(w.ran).toEqual(['clear'])
})
