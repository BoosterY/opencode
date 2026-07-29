# TUI `mouse_select` Toggle Design

## Problem

When the LLM asks a question with selectable options (question dialog, permission
prompt, autocomplete, generic select dialog), a user who wants to copy option text
with the mouse triggers option selection instead. A single click commits the
selection because each option row commits on `onMouseUp`.

The existing text-selection guard (`if (renderer.getSelection()?.getSelectedText()) return`)
only helps when text is already selected (a drag). It does nothing for a plain
click, which is still interpreted as choosing that option.

## Goal

Add an opt-in TUI setting that lets users make option lists ignore the mouse
entirely, so the mouse can be used freely to select/copy text. Selection and
navigation happen only via the keyboard.

## Design

### Config

Add a new boolean field `mouse_select` to the TUI config schema in
`packages/tui/src/config/index.tsx`:

- Schema: `mouse_select: Schema.optional(Schema.Boolean)` with description
  "Enable selecting options with the mouse (default: true). Disable to use the
  mouse for copying option text."
- Resolved type: `mouse_select: boolean`
- Default in `resolve()`: `input.mouse_select ?? true` (preserves current behavior).
- Update the `Omit<...>` in the `Resolved` type to exclude `mouse_select`.

### Behavior (`mouse_select: false`)

Semantics: **the mouse does not participate in option selection at all.** Option
rows ignore mouse hover, mousedown, and mouseup. Keyboard navigation and
confirmation are unaffected. Text selection / copy-on-select continues to work
because the option rows simply stop reacting to the mouse.

This is the "clean" semantic (option A from brainstorming): hover highlight is
also disabled, so the keyboard-selected option can't be silently overridden by
whatever the mouse last hovered.

### Affected components

Each of these renders an option list and commits selection on `onMouseUp`. When
`tuiConfig.mouse_select` is `false`, the mouse handlers on the option rows become
no-ops (guarded early return, so hover/mousedown/mouseup all bail out):

1. `packages/tui/src/routes/session/question.tsx`
   - Option rows (`onMouseOver`/`onMouseDown`/`onMouseUp`, ~370-375)
   - Custom "type your own" row (~402-407)
   - Note: tabs (~315-320, 343-348) are navigation, not answer selection. Keep
     tab mouse handling unchanged; only the answer option rows and the custom row
     are gated. (Decision: the reported problem is copying option text, and tabs
     are short headers; leaving tabs mouse-navigable is lower risk. Revisit if the
     user wants tabs gated too.)
2. `packages/tui/src/routes/session/permission.tsx`
   - `Prompt` option buttons (~683-687). Has `tuiConfig` already.
3. `packages/tui/src/component/prompt/autocomplete.tsx`
   - Option rows (~754-765). Has `tuiConfig` already.
4. `packages/tui/src/ui/dialog-select.tsx`
   - Option rows (~642-664). Has `tuiConfig` already.

Implementation approach per component: read `tuiConfig.mouse_select` and guard the
row-level mouse handlers with an early `return` when it is `false`. Where a handler
is a single expression (e.g. `onMouseUp={() => select()}`), convert to a block with
the guard.

### User's personal config

After implementation, set `mouse_select: false` in the user's personal opencode
config so the mouse can be used to copy option text. Locate the user config
(`~/.config/opencode/opencode.json` or equivalent) and add the field.

## Testing / Verification

- `bun typecheck` from `packages/tui`.
- Manual: with `mouse_select: false`, verify clicking an option in a question
  prompt does not select it, and text can be dragged/copied; with the default
  (unset / true) behavior is unchanged.

## Out of scope

- Changing the global default (stays `true`).
- Gating question tabs on the mouse setting.
- Any change to the existing `mouse` (capture) flag or copy-on-select flag.
