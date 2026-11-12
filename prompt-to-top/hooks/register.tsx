import type { Register, RenderElement } from 'claude-code'

const POLL_MS = 40
const WAIT_MS = 3000
const FALLBACK_ROWS = 40
const SCROLL_DELAYS_MS = [60, 200]
const HANDOVER_MS = 150
const REPAIR_POLL_MS = 80
const REPAIR_WINDOW_MS = 600
// The `✻ Done` line and the margin above it.
const DONE_ROWS = 2
// A hook that runs past 10 seconds is cut off, so the submit hook leaves first.
const SUBMIT_HOOK_MS = 8000

export const register: Register = on => {
  // The newest prompt row the person typed, as the transcript last drew it.
  let latestPrompt: string | undefined
  // The last row of the current turn. While the turn runs it carries a screen
  // of blank rows, so the transcript always has room to keep the prompt at
  // the top. The engine does not draw rows that far below the view, its
  // turn-duration line included, so the tail row marks the turn's end itself.
  let tail: string | undefined
  let isTurnRunning = false
  // Set once this turn's prompt row is drawn. Rows drawn for the first time
  // before it belong to earlier turns and never become the tail.
  let hasPromptRow = false
  let screenRows = FALLBACK_ROWS
  // The tail's blank rows once the turn has ended: only those the view shows.
  let padRows = FALLBACK_ROWS
  // The blank rows the tail's last draw used, which its `onScreen` counts.
  let drawnPad = FALLBACK_ROWS
  const seen = new Set<string>()
  // Text blocks still streaming, oldest first. The engine draws its own live
  // text below the tail's blank rows, off screen, so the tail row draws these.
  // A block stays until its settled row is drawn, which never happens when
  // that row lies too far below the view for the engine to draw it.
  const live = new Map<string, string>()
  let spinnerLine = ''
  // Earlier tails that keep drawing as the tail, live text and blank rows
  // included, until the new tail is laid out. A frame with no blank rows
  // shrinks the transcript under the view, and the engine then follows the
  // output to the bottom again. A frame where the old tail drops its live
  // text shows the new tail's copy a screen lower, out of view.
  const handingOver = new Set<string>()
  // Whether the transcript's view shows this turn's prompt row.
  let isPromptShown = true
  // A row that is the tail can be replaced by another (a tool call folding
  // into a group) and take its blank rows with it for a frame. If the prompt
  // leaves the view before this time, the submit hook scrolls it back.
  let repairUntil = 0
  let turnCount = 0
  let isRepairing = false
  // True from a submit until its first scrolls ran. The engine jumps to the
  // transcript's end on submit, which shows blank rows for a moment.
  let isSettling = false
  // Set by a submit that starts a turn, until that turn's prompt row is drawn.
  let isAwaitingPrompt = false

  // Makes a row the tail the first time it is drawn. Returns the tail it
  // replaced, '' when there was none, or undefined when the tail stays.
  const claimTail = (key: string, mayClaim: boolean) => {
    const isNew = !seen.has(key)
    seen.add(key)

    if (!isNew || !mayClaim) {
      return undefined
    }

    const replaced = tail ?? ''
    tail = key

    if (isPromptShown) {
      repairUntil = Date.now() + REPAIR_WINDOW_MS
    }

    if (replaced !== '') {
      handingOver.add(replaced)
    }

    return replaced
  }

  const blankRows = (ui: any, tree: RenderElement, pad: number): RenderElement => (
    <ui.Box flexDirection="column">
      {tree}
      <ui.Box height={pad} />
    </ui.Box>
  )

  // While a handover runs, only the old tail draws the live text, so the
  // answer never shows twice whichever of the two rows redraws first.
  const draw = (key: string, ui: any, tree: RenderElement): RenderElement => {
    if (key === tail) {
      drawnPad = isTurnRunning ? screenRows : Math.min(padRows, screenRows)

      return handingOver.size > 0 ? blankRows(ui, tree, drawnPad) : asTail(ui, tree, drawnPad)
    }

    return handingOver.has(key) ? asTail(ui, tree, screenRows) : tree
  }

  // A settled reply block replaces the oldest block that was streaming.
  const settleOldestLive = () => {
    const oldest = live.keys().next()

    if (!oldest.done) {
      live.delete(oldest.value)
    }
  }

  const dropBlankRows = () => {
    tail = undefined
    handingOver.clear()
    padRows = screenRows
    drawnPad = screenRows
  }

  // Fits the tail's blank rows to where its `onScreen` says the view stands.
  // Returns a note for the debug log when it changed them.
  //
  // A view that shows only blank rows, and that nothing can scroll back, has
  // lost the prompt: a permission prompt, or the end of a long answer, took
  // it there. The blank rows go, and the view follows the output again.
  //
  // Once the answer is done, blank rows below the view only leave a gap to
  // scroll into, so they go. When the view no longer shows the answer's end,
  // all of them go and the engine draws the turn's end itself. While a reply
  // block is still drawn from `live`, its settled row would then show under
  // it a second time, so the rows stay.
  const fitBlankRows = (key: string, onScreen: { first: number; last: number; of: number } | null | undefined) => {
    if (key !== tail || !onScreen || isSettling) {
      return undefined
    }

    const padStart = onScreen.of - drawnPad
    const where = `of=${onScreen.of} first=${onScreen.first} last=${onScreen.last} pad=${drawnPad}`
    const canRepair = isRepairing && Date.now() < repairUntil

    if (drawnPad > 0 && onScreen.first >= padStart && !canRepair) {
      dropBlankRows()

      return `view lost, ${where}`
    }

    const hasLiveText = [...live.values()].some(text => text.trim() !== '')

    if (isTurnRunning || hasLiveText) {
      return undefined
    }

    if (onScreen.last < padStart - DONE_ROWS) {
      dropBlankRows()

      return `answer end off screen, ${where}`
    }

    const visiblePad = Math.max(0, onScreen.last - padStart + 1)

    if (visiblePad < drawnPad) {
      padRows = visiblePad

      return `trimmed to ${visiblePad}, ${where}`
    }

    return undefined
  }

  const asTail = (ui: any, tree: RenderElement, pad: number): RenderElement => {
    const { Box, Text, Markdown } = ui
    const blocks = [...live.entries()].filter(([, text]) => text.trim() !== '')
    const isSpinnerShown = isTurnRunning && blocks.length === 0 && spinnerLine !== ''

    return (
      <Box flexDirection="column">
        {tree}
        {blocks.map(([id, text]) => (
          <Box key={id} flexDirection="row" marginTop={1}>
            <Text>⏺ </Text>
            <Markdown text={text} />
          </Box>
        ))}
        {isSpinnerShown ? (
          <Box marginTop={1}>
            <Text dimColor>✻ {spinnerLine}</Text>
          </Box>
        ) : null}
        {isTurnRunning ? null : (
          <Box marginTop={1}>
            <Text dimColor>✻ Done</Text>
          </Box>
        )}
        <Box height={pad} />
      </Box>
    )
  }

  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    if (e.surface !== 'terminal' || e.props.origin.kind !== 'composer') {
      return next(e)
    }

    const key = `UserMessage:${e.requestId}`

    const replaced = claimTail(key, isTurnRunning)

    if (replaced !== undefined) {
      $.clock.after(HANDOVER_MS, () => {
        handingOver.delete(replaced)
        $.ui.invalidate('ui.render')
      })
    }

    if (replaced !== undefined && isAwaitingPrompt && e.requestId !== 'placeholder') {
      latestPrompt = e.requestId
      hasPromptRow = true
      isAwaitingPrompt = false
    }

    if (e.requestId === latestPrompt) {
      isPromptShown = e.props.onScreen !== null
    }

    screenRows = e.viewport?.rows ?? screenRows
    const fitted = fitBlankRows(key, e.props.onScreen)

    if (fitted !== undefined) {
      $.ui.log(`prompt-to-top: ${fitted}`, { to: 'debug' })
      $.ui.invalidate('ui.render')
    }

    const tree = await next(e)

    return draw(key, $.ui.resolve(e), tree)
  })

  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    if (e.surface !== 'terminal') {
      return next(e)
    }

    const key = `AssistantMessage:${e.requestId}`

    const replaced = claimTail(key, hasPromptRow && isTurnRunning)

    if (replaced !== undefined) {
      $.clock.after(HANDOVER_MS, () => {
        settleOldestLive()
        handingOver.delete(replaced)
        $.ui.invalidate('ui.render')
      })
    }

    const fitted = fitBlankRows(key, e.props.onScreen)

    if (fitted !== undefined) {
      $.ui.log(`prompt-to-top: ${fitted}`, { to: 'debug' })
      $.ui.invalidate('ui.render')
    }

    const tree = await next(e)

    return draw(key, $.ui.resolve(e), tree)
  })

  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    if (e.surface !== 'terminal') {
      return next(e)
    }

    const key = `ToolUse:${e.requestId}`

    const replaced = claimTail(key, hasPromptRow && isTurnRunning)

    if (replaced !== undefined) {
      $.clock.after(HANDOVER_MS, () => {
        handingOver.delete(replaced)
        $.ui.invalidate('ui.render')
      })
    }

    const fitted = fitBlankRows(key, e.props.onScreen)

    if (fitted !== undefined) {
      $.ui.log(`prompt-to-top: ${fitted}`, { to: 'debug' })
      $.ui.invalidate('ui.render')
    }

    const tree = await next(e)

    return draw(key, $.ui.resolve(e), tree)
  })

  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    if (e.surface !== 'terminal') {
      return next(e)
    }

    const key = `ToolResult:${e.requestId}`

    const replaced = claimTail(key, hasPromptRow && isTurnRunning)

    if (replaced !== undefined) {
      $.clock.after(HANDOVER_MS, () => {
        handingOver.delete(replaced)
        $.ui.invalidate('ui.render')
      })
    }

    const fitted = fitBlankRows(key, e.props.onScreen)

    if (fitted !== undefined) {
      $.ui.log(`prompt-to-top: ${fitted}`, { to: 'debug' })
      $.ui.invalidate('ui.render')
    }

    const tree = await next(e)

    return draw(key, $.ui.resolve(e), tree)
  })

  on('ui.render', { component: 'ToolGroup' }, async ($, e, next) => {
    if (e.surface !== 'terminal') {
      return next(e)
    }

    const key = `ToolGroup:${e.requestId}`

    const replaced = claimTail(key, hasPromptRow && isTurnRunning)

    if (replaced !== undefined) {
      $.clock.after(HANDOVER_MS, () => {
        handingOver.delete(replaced)
        $.ui.invalidate('ui.render')
      })
    }

    const fitted = fitBlankRows(key, e.props.onScreen)

    if (fitted !== undefined) {
      $.ui.log(`prompt-to-top: ${fitted}`, { to: 'debug' })
      $.ui.invalidate('ui.render')
    }

    const tree = await next(e)

    return draw(key, $.ui.resolve(e), tree)
  })

  // The engine's spinner sits below the blank rows, so the tail row shows
  // its words instead.
  on('ui.render', { component: 'Spinner' }, ($, e, next) => {
    const line = `${e.props.message ?? e.props.word}${e.props.suffix}`

    if (e.surface === 'terminal' && isTurnRunning && line !== spinnerLine) {
      spinnerLine = line
      $.ui.invalidate('ui.render')
    }

    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const stream = next(e)[Symbol.asyncIterator]()

    while (true) {
      const item = await stream.next()

      if (item.done) {
        return item.value
      }

      const chunk = item.value

      if (e.agentId === undefined && chunk.kind === 'text') {
        const id = `${e.index}:${chunk.index}`
        live.set(id, (live.get(id) ?? '') + chunk.text)
        $.ui.invalidate('ui.render')
      }

      yield chunk
    }
  })

  // A turn no submit of ours started (a queued prompt, a task notification)
  // draws its rows below the last turn's blank rows, so those go.
  on('turn.start', ($, e, next) => {
    if (!isTurnRunning && tail !== undefined) {
      dropBlankRows()
      $.ui.invalidate('ui.render')
    }

    return next(e)
  })

  on('turn.complete', ($, e, next) => {
    if (isTurnRunning) {
      isTurnRunning = false
      spinnerLine = ''

      // An interrupted or failed turn ends in rows no hook draws, which would
      // sit below the blank rows, so the blank rows go.
      if (e.reason !== 'answer') {
        dropBlankRows()
        live.clear()
      }

      $.ui.invalidate('ui.render')
    }

    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    // A prompt typed while a turn runs is queued: it joins that turn or starts
    // a later one, which `turn.start` handles.
    if (e.origin?.kind !== 'composer' || e.command || isTurnRunning) {
      return next(e)
    }

    const startedAt = Date.now()
    const promptBefore = latestPrompt
    isTurnRunning = true
    hasPromptRow = false
    isPromptShown = true
    repairUntil = 0
    turnCount += 1
    isAwaitingPrompt = true
    isSettling = true
    live.clear()
    spinnerLine = ''
    seen.delete('UserMessage:placeholder')
    // On submit the engine jumps to the transcript's end. Without the last
    // turn's blank rows that end is the new prompt, not an empty screen.
    dropBlankRows()
    $.ui.invalidate('ui.render')
    const result = await next(e)

    // The row is drawn only after the prompt has entered, and the transcript
    // scrolls only while this hook is still answering the person's input.
    let waited = 0
    while (latestPrompt === promptBefore && waited < WAIT_MS) {
      await $.clock.sleep(POLL_MS)
      waited += POLL_MS
    }

    if (latestPrompt === undefined || latestPrompt === promptBefore) {
      $.ui.log(`prompt-to-top: no new prompt row after ${waited}ms`, { to: 'debug' })
      isSettling = false

      return result
    }

    // The first scroll can run before the prompt's blank rows are laid out and
    // stop short, so a second one follows once they are.
    let outcome = ''
    for (const delay of SCROLL_DELAYS_MS) {
      await $.clock.sleep(delay)
      const moved = await $.ui.scroll({ to: { requestId: latestPrompt }, block: 'start' })
      outcome = moved.deny ?? 'scrolled'
    }

    $.ui.log(`prompt-to-top: waited ${waited}ms, ${outcome}`, { to: 'debug' })

    // The transcript scrolls for this hook only while it is still answering,
    // so it stays open for the turn to repair a lost view.
    const turn = turnCount
    isRepairing = true
    isSettling = false
    while (isTurnRunning && turn === turnCount && Date.now() - startedAt < SUBMIT_HOOK_MS) {
      await $.clock.sleep(REPAIR_POLL_MS)

      if (!isPromptShown && Date.now() < repairUntil && tail !== undefined) {
        const repaired = await $.ui.scroll({ to: { requestId: latestPrompt }, block: 'start' })
        $.ui.log(`prompt-to-top: repaired view, ${repaired.deny ?? 'scrolled'}`, { to: 'debug' })
      }
    }

    if (turn === turnCount) {
      isRepairing = false
    }

    return result
  })
}
