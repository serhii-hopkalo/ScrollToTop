# prompt-to-top

A Claude Code mod that scrolls your prompt to the top of the terminal view when you press Enter. The answer then fills in below it line by line, so the text you are reading does not move up while it streams.

Tested with Claude Code 2.1.322 and the fullscreen renderer (`"tui": "fullscreen"`).

## Use

Start Claude Code with the mod:

```bash
claude --plugin-dir /path/to/ScrollToTop/prompt-to-top
```

To load it in every session, add an alias to your shell profile:

```bash
alias claude='claude --plugin-dir /path/to/ScrollToTop/prompt-to-top'
```

A session started this way reloads the mod at the next prompt after its files change.

## How it works

- On submit, the mod scrolls the new prompt row to the top with `$.ui.scroll`.
- A screen of blank rows under the last row of the turn gives the transcript room to hold that position. Without them the scroll stops at the end of the content.
- Claude Code draws its live text and spinner below those blank rows, out of view, so the mod draws the streaming text and the spinner words itself.
- When the answer is done, blank rows below the view are removed, so there is no gap to scroll into. Once the end of the answer is out of view, all of them go and Claude Code draws the turn's end as usual.

## Known limits

- The screen is blank for about 0.1 seconds after Enter, before the prompt lands at the top.
- While the mod draws the turn, the spinner has no timer or token count, and a short answer ends with `✻ Done` instead of `✻ Cooked for Ns`.
- When a tool row first appears, the view jumps to the bottom for one frame.
- If a turn writes more than about a screen of text and then calls a tool, that tool row stays hidden until the next prompt.
- A permission prompt, an interrupt, or a view lost more than 8 seconds into a turn makes the mod give up for that turn. The view then follows the output to the bottom as usual.
- An answer longer than the screen needs a manual scroll down for the rest.
- Window resize, thinking output and subagents are untested.

## Development

The code is `prompt-to-top/hooks/register.tsx`. Check it with:

```bash
claude plugin validate prompt-to-top
npx -p typescript tsc -p prompt-to-top
```

The type check needs the type definitions in `prompt-to-top/.claude-plugin/types`. Claude Code generates that folder locally, and git ignores it.

Start Claude Code with `--debug` to see the mod's scroll and blank-row decisions in the debug log, prefixed `prompt-to-top:`.
