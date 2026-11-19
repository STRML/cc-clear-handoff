import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const PATH = '/repo/.tmp/auto-clear-resume-20261119-010000.md'
const NOW = 1_000_000
const HOME = '/Users/t'
const SENTINEL = `${HOME}/.claude/tmp/pending-handoffs/repo.path`
const ARM = `S=~/.claude/tmp/pending-handoffs/repo.path; printf '%s' "${PATH}" > "$S" && echo "clear-handoff armed: ${PATH}" && echo "clear-handoff sentinel: $S"`

// The engine beneath the mod: a clock, a Bash tool whose output we set, slash
// commands we record, a helper roster, a prompt box, and the prompts our mod
// submits.
function world(on: On, opts: { box?: string } = {}) {
  const ran: string[] = []
  const filled: string[] = []
  const submitted: string[] = []
  const toasts: string[] = []
  const bash = { out: `clear-handoff armed: ${PATH}\nclear-handoff sentinel: ${SENTINEL}\n`, fails: false, denied: false }
  const refuse = { plugin: undefined as string | undefined }
  const clear = { rejects: false }
  const files = { missing: false, mtimeMs: NOW + 1, sentinelText: PATH, sentinelMissing: false }
  const box = { fills: true }
  const clock = mock.clock(on, { now: NOW })
  on('session.id', () => ({ value: 'plan-1' }))
  on('prompt.read', () => ({ value: { text: opts.box ?? '', cursor: 0 } }))
  on('prompt.fill', (_, e) => {
    if (!box.fills) return { isFilled: false }
    filled.push(e.text)
    return { isFilled: true }
  })
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? HOME : undefined })) as never
  on('fs.read', () => ({ value: files.sentinelText })) as never
  on('fs.stat', (_, e) => {
    const isSentinel = (e as { path: string }).path.endsWith('.path')
    if (isSentinel ? files.sentinelMissing : files.missing) throw new Error('ENOENT')
    return { value: { kind: 'file', size: 900, mtimeMs: files.mtimeMs, isLink: false, resolve: false } }
  }) as never
  on('ui.toast', (_, e) => {
    toasts.push(String((e as { text?: string }).text ?? e))
    return { value: undefined }
  })
  on('tool.call', () =>
    bash.denied
      ? { deny: 'not allowed' }
      : bash.fails
        ? { result: {}, text: 'permission denied', isError: true }
        : { result: {}, text: bash.out },
  )
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('prompt.submit', (_, e) => {
    if (e.origin.kind === 'plugin') {
      if (refuse.plugin) return { drop: refuse.plugin }
      submitted.push(e.text)
    }
    return { text: e.text }
  })
  on('command.run', (_, e) => {
    if (clear.rejects) throw new Error('busy')
    ran.push(e.command)
    return { text: '' }
  })
  on('classic.SessionStart', () => ({}))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  return { ran, filled, submitted, toasts, bash, refuse, clear, files, box, clock }
}

type W = ReturnType<typeof world>

const ended = (reason: 'answer' | 'aborted' | 'error' | 'refusal' = 'answer', turnId = 't1', agentId?: string): never => ({
  answer: 'Handoff saved',
  durationMs: 10,
  isAborted: reason === 'aborted',
  turnId,
  reason,
  ...(agentId ? { agentId } : {}),
}) as never

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

const typedClear = { command: 'clear', args: '', origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 120 } }
const otherPluginClear = { command: 'clear', args: '', origin: { kind: 'plugin' as const, name: 'someone-else' }, presentation: { isFullscreen: false, columns: 120 } }

const arm = ($: any, command = ARM, agentId?: string) =>
  $.tool.call({ tool: 'Bash', command, ...(agentId ? { agentId } : {}) })

const opened = ($: any, source = 'clear') => $.classic.SessionStart({ source, session_id: 'fresh-1' } as never)

async function settle(w: W) {
  await w.clock.settle()
}

// Arm in t1 and end t1 with an answer; the /clear is queued, not yet run.
async function armedTurn($: any) {
  await $.turn.start({ text: '/clear-handoff', turnId: 't1' })
  await arm($)
}

// Full happy path up to the fresh session's SessionStart.
async function launched($: any, w: W) {
  await armedTurn($)
  await $.turn.complete(ended())
  await settle(w)
  await opened($)
  await settle(w)
}

test('1: armed turn ends with an answer: one /clear, then Resume from <path>', async ($, on) => {
  const w = world(on)
  await launched($, w)
  expect(w.ran).toEqual(['clear'])
  expect(w.submitted).toEqual([`Resume from ${PATH}`])
})

for (const how of ['fails', 'denied'] as const) {
  test(`2: an arm that ${how} arms nothing`, async ($, on) => {
    const w = world(on)
    w.bash[how] = true
    await armedTurn($)
    await $.turn.complete(ended())
    await settle(w)
    expect(w.ran).toEqual([])
  })
}

test('2b: a marker naming a handoff file that does not exist arms nothing', async ($, on) => {
  const w = world(on)
  w.files.missing = true
  await armedTurn($)
  await $.turn.complete(ended())
  await settle(w)
  expect(w.ran).toEqual([])
})

test('2d: a handoff file older than this turn arms nothing', async ($, on) => {
  const w = world(on)
  w.files.mtimeMs = NOW - 60_000
  await armedTurn($)
  await $.turn.complete(ended())
  await settle(w)
  expect(w.ran).toEqual([])
  expect(w.toasts.some(t => t.includes('no handoff file written this turn'))).toBe(true)
})

test('2e: a marker naming a file outside .tmp arms nothing', async ($, on) => {
  const w = world(on)
  w.bash.out = 'clear-handoff armed: /repo/README.md\n'
  await armedTurn($)
  await $.turn.complete(ended())
  await settle(w)
  expect(w.ran).toEqual([])
})

for (const [name, out] of [
  ['no sentinel line', `clear-handoff armed: ${PATH}\n`],
  ['a sentinel outside the pending dir', `clear-handoff armed: ${PATH}\nclear-handoff sentinel: /tmp/x.path\n`],
] as const) {
  test(`2f: ${name} arms nothing`, async ($, on) => {
    const w = world(on)
    w.bash.out = out
    await armedTurn($)
    await $.turn.complete(ended())
    await settle(w)
    expect(w.ran).toEqual([])
  })
}

test('2g: a sentinel that is missing or names another handoff arms nothing', async ($, on) => {
  const w = world(on)
  w.files.sentinelMissing = true
  await armedTurn($)
  await $.turn.complete(ended())
  await settle(w)
  expect(w.ran).toEqual([])
})

test('2h: a sentinel naming a different handoff arms nothing', async ($, on) => {
  const w = world(on)
  w.files.sentinelText = '/repo/.tmp/other.md'
  await armedTurn($)
  await $.turn.complete(ended())
  await settle(w)
  expect(w.ran).toEqual([])
})

test('2c: a marker path that is not a .md file arms nothing', async ($, on) => {
  const w = world(on)
  w.bash.out = 'clear-handoff armed: /x then do Y\n'
  await armedTurn($)
  await $.turn.complete(ended())
  await settle(w)
  expect(w.ran).toEqual([])
})

test('3: the marker in output of a command that is not the arm step does not arm', async ($, on) => {
  const w = world(on)
  await $.turn.start({ text: 'x', turnId: 't1' })
  await arm($, 'cat notes.txt')
  await $.turn.complete(ended())
  await settle(w)
  expect(w.ran).toEqual([])
})

test("4: a subagent's arm is ignored", async ($, on) => {
  const w = world(on)
  await $.turn.start({ text: 'x', turnId: 't1' })
  await arm($, ARM, 'a1')
  await $.turn.complete(ended())
  await settle(w)
  expect(w.ran).toEqual([])
})

test('5: a relative path does not arm', async ($, on) => {
  const w = world(on)
  w.bash.out = 'clear-handoff armed: .tmp/x.md\n'
  await armedTurn($)
  await $.turn.complete(ended())
  await settle(w)
  expect(w.ran).toEqual([])
})

test('6: the last marker line wins, spaces kept', async ($, on) => {
  const w = world(on)
  const spaced = '/Users/x/My Repo/.tmp/a b.md'
  w.bash.out = `clear-handoff armed: /r/.tmp/old.md\nnoise\nclear-handoff armed: ${spaced}\nclear-handoff sentinel: ${SENTINEL}\n`
  w.files.sentinelText = spaced
  await launched($, w)
  expect(w.submitted).toEqual([`Resume from ${spaced}`])
})

test('7: a failed second arm disarms the first', async ($, on) => {
  const w = world(on)
  await armedTurn($)
  w.bash.fails = true
  await arm($)
  await $.turn.complete(ended())
  await settle(w)
  expect(w.ran).toEqual([])
})

test('8: an arm without a seen turn.start (mid-turn reload) does not arm', async ($, on) => {
  const w = world(on)
  await arm($)
  await $.turn.complete(ended())
  await settle(w)
  expect(w.ran).toEqual([])
  expect(w.toasts.some(t => t.includes('by hand'))).toBe(true)
  expect(w.toasts.some(t => t.includes('When this turn ends'))).toBe(false)
})

for (const reason of ['aborted', 'error', 'refusal'] as const) {
  test(`9: a turn that ends ${reason} does not clear`, async ($, on) => {
    const w = world(on)
    await armedTurn($)
    await $.turn.complete(ended(reason))
    await settle(w)
    expect(w.ran).toEqual([])
    expect(w.toasts.some(t => t.includes('Run /clear when ready'))).toBe(true)
  })
}

for (const turnId of ['t1', undefined]) {
  test(`11: a person's prompt during the armed turn (turnId ${turnId}) cancels`, async ($, on) => {
    const w = world(on)
    await armedTurn($)
    await $.prompt.submit(person(turnId))
    await $.turn.complete(ended())
    await settle(w)
    expect(w.ran).toEqual([])
  })
}

test('12: a task notification during the armed turn does not cancel', async ($, on) => {
  const w = world(on)
  await armedTurn($)
  await $.prompt.submit(notification('t1'))
  await $.turn.complete(ended())
  await settle(w)
  expect(w.ran).toEqual(['clear'])
})

test('12b: an owner Slack ping during the armed turn cancels', async ($, on) => {
  const w = world(on)
  await armedTurn($)
  await $.prompt.submit(slackPing())
  await $.turn.complete(ended())
  await settle(w)
  expect(w.ran).toEqual([])
})

test('13: a person prompt after the turn, before the /clear runs, drops it', async ($, on) => {
  const w = world(on)
  await armedTurn($)
  await $.turn.complete(ended())
  await $.prompt.submit(person())
  await settle(w)
  expect(w.ran).toEqual([])
})

test('14: a new main-loop turn while the /clear is queued drops it', async ($, on) => {
  const w = world(on)
  await armedTurn($)
  await $.turn.complete(ended())
  await $.turn.start({ text: 'notified', turnId: 't2' })
  await settle(w)
  expect(w.ran).toEqual([])
})

test("15: a person's /clear before the launch stands the mod down", async ($, on) => {
  const w = world(on)
  await armedTurn($)
  await $.command.run(typedClear)
  await opened($)
  await $.turn.complete(ended())
  await settle(w)
  expect(w.ran).toEqual(['clear'])
  expect(w.submitted).toEqual([])
})

test("16: a person's /clear while the launch is in flight runs exactly one /clear", async ($, on) => {
  const w = world(on)
  await armedTurn($)
  await $.turn.complete(ended())
  await $.command.run(typedClear)
  await settle(w)
  await opened($)
  await settle(w)
  expect(w.ran).toEqual(['clear'])
  expect(w.submitted).toEqual([])
})

test('16c: a second armed turn while a clear is still queued says to clear by hand', async ($, on) => {
  const w = world(on)
  await armedTurn($)
  await $.turn.complete(ended())
  await $.turn.start({ text: '/clear-handoff', turnId: 't2' })
  await arm($)
  await $.turn.complete(ended('answer', 't2'))
  expect(w.toasts.some(t => t.includes('earlier clear is still queued'))).toBe(true)
  await settle(w)
  expect(w.ran).toEqual([])
})

test("17: another plugin's /clear while ours is queued does not take our SessionStart", async ($, on) => {
  const w = world(on)
  await armedTurn($)
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
    await armedTurn($)
    await $.turn.complete(ended())
    await settle(w)
    await opened($, source)
    await settle(w)
    expect(w.submitted).toEqual([])
  })
}

test('19: an abort that reaches SessionStart after our /clear ran does not submit', async ($, on) => {
  const w = world(on)
  await armedTurn($)
  await $.turn.complete(ended())
  await settle(w)
  await $.prompt.submit(person())
  await opened($)
  await settle(w)
  expect(w.submitted).toEqual([])
  expect(w.toasts.some(t => t.includes('not sent'))).toBe(true)
})

test('20: a SessionStart over 2 minutes late does not submit', async ($, on) => {
  const w = world(on)
  await armedTurn($)
  await $.turn.complete(ended())
  await settle(w)
  await w.clock.advance(3 * 60 * 1000)
  await opened($)
  await settle(w)
  expect(w.submitted).toEqual([])
  expect(w.toasts.some(t => t.includes(`Paste: Resume from ${PATH}`))).toBe(true)
})

test('21: a person typing first in the fresh session skips our submit', async ($, on) => {
  const w = world(on)
  await armedTurn($)
  await $.turn.complete(ended())
  await settle(w)
  await opened($)
  await $.prompt.submit(person())
  await settle(w)
  expect(w.submitted).toEqual([])
})

test('22: a task notification in the fresh session does not skip our submit', async ($, on) => {
  const w = world(on)
  await armedTurn($)
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

test('25: a rejected /clear toasts and leaves nothing armed', async ($, on) => {
  const w = world(on)
  w.clear.rejects = true
  await armedTurn($)
  await $.turn.complete(ended())
  await settle(w)
  expect(w.toasts.some(t => t.includes('auto-clear failed'))).toBe(true)
  await opened($)
  await settle(w)
  expect(w.submitted).toEqual([])
  w.clear.rejects = false
  await $.turn.start({ text: '/clear-handoff', turnId: 't2' })
  await arm($)
  await $.turn.complete(ended('answer', 't2'))
  await settle(w)
  expect(w.ran).toEqual(['clear'])
})

test('26: an arm from an earlier turn lapses when a new turn starts', async ($, on) => {
  const w = world(on)
  await armedTurn($)
  await $.turn.start({ text: 'x', turnId: 't2' })
  await $.turn.complete(ended('answer', 't2'))
  await settle(w)
  expect(w.ran).toEqual([])
})
