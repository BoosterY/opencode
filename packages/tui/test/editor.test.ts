import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { normalizePromptContent, openEditor } from "../src/editor"
import { tmpdir } from "./fixture/fixture"

const editor = process.env.EDITOR
const visual = process.env.VISUAL
const zellij = process.env.ZELLIJ
const zellijPane = process.env.ZELLIJ_PANE_ID
const pathEnv = process.env.PATH

// The suspend-path tests must not depend on whether the test runner itself
// happens to be inside a zellij pane.
beforeEach(() => {
  delete process.env.ZELLIJ
  delete process.env.ZELLIJ_PANE_ID
})

afterEach(() => {
  process.env.EDITOR = editor
  process.env.VISUAL = visual
  restore("ZELLIJ", zellij)
  restore("ZELLIJ_PANE_ID", zellijPane)
  process.env.PATH = pathEnv
})

function restore(key: string, value: string | undefined) {
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

// Installs a fake `zellij` on PATH that logs its argv and, for `run`, executes
// the trailing command (the `sh -c <resize script> sh <editor> <file>` tail).
async function fakeZellij(dir: string, opts: { reachable: boolean }) {
  const log = path.join(dir, "zellij.log")
  const bin = path.join(dir, "bin")
  await mkdir(bin)
  await writeFile(
    path.join(bin, "zellij"),
    [
      "#!/bin/sh",
      `printf '%s\\n' "$*" >> ${JSON.stringify(log)}`,
      `if [ "$1 $2" = "action query-tab-names" ]; then exit ${opts.reachable ? 0 : 1}; fi`,
      'if [ "$1" = "action" ]; then exit 0; fi',
      'if [ "$1" = "run" ]; then',
      '  while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done',
      "  shift",
      '  exec "$@"',
      "fi",
    ].join("\n"),
    { mode: 0o755 },
  )
  process.env.PATH = `${bin}:${pathEnv}`
  return { log: async () => (await readFile(log, "utf8")).trim().split("\n") }
}

function renderer(events: string[] = []) {
  return {
    async suspend() {
      events.push("suspend")
    },
    async resume() {
      events.push("resume")
    },
  }
}

test("rejects when the external editor cannot start", async () => {
  delete process.env.VISUAL
  process.env.EDITOR = "opencode-editor-that-does-not-exist"

  await expect(openEditor({ value: "original", renderer: renderer() as never })).rejects.toThrow()
})

test.skipIf(process.platform === "win32")("returns the edited prompt and resumes the renderer", async () => {
  await using tmp = await tmpdir()
  const script = path.join(tmp.path, "editor.sh")
  await writeFile(script, '#!/bin/sh\nprintf edited >> "$1"\n', { mode: 0o755 })
  delete process.env.VISUAL
  process.env.EDITOR = script
  const events: string[] = []

  expect(await openEditor({ value: "original ", renderer: renderer(events) as never })).toBe("original edited")
  expect(events).toEqual(["suspend", "resume"])
})

test("says which variable to set when no external editor is configured", async () => {
  delete process.env.VISUAL
  delete process.env.EDITOR
  let suspended = false
  const renderer = {
    suspend() {
      suspended = true
    },
    resume() {},
    requestRender() {},
    currentRenderBuffer: { clear() {} },
  }

  await expect(openEditor({ value: "original", renderer: renderer as never })).rejects.toThrow("$EDITOR")
  expect(suspended).toBe(false)
})

test.skipIf(process.platform === "win32")("opens the editor in a zellij split without suspending", async () => {
  await using tmp = await tmpdir()
  const zellij = await fakeZellij(tmp.path, { reachable: true })
  const script = path.join(tmp.path, "editor.sh")
  await writeFile(script, '#!/bin/sh\nprintf edited >> "$1"\n', { mode: 0o755 })
  delete process.env.VISUAL
  process.env.EDITOR = script
  process.env.ZELLIJ = "0"
  process.env.ZELLIJ_PANE_ID = "7"
  const events: string[] = []
  const renderer = { ...rendererWithRender(events) }

  expect(await openEditor({ value: "original ", renderer: renderer as never, cwd: tmp.path })).toBe("original edited")
  expect(events).toEqual(["render"])
  const calls = await zellij.log()
  expect(calls[0]).toBe("action query-tab-names")
  expect(calls[1]).toStartWith(`run --name editor --direction down --close-on-exit --block-until-exit --cwd ${tmp.path} --`)
  expect(calls.at(-1)).toBe("action focus-pane-id 7")
})

test.skipIf(process.platform === "win32")("falls back to suspending when zellij is unreachable", async () => {
  await using tmp = await tmpdir()
  const zellij = await fakeZellij(tmp.path, { reachable: false })
  const script = path.join(tmp.path, "editor.sh")
  await writeFile(script, '#!/bin/sh\nprintf edited >> "$1"\n', { mode: 0o755 })
  delete process.env.VISUAL
  process.env.EDITOR = script
  process.env.ZELLIJ = "0"
  const events: string[] = []

  expect(await openEditor({ value: "original ", renderer: renderer(events) as never })).toBe("original edited")
  expect(events).toEqual(["suspend", "resume"])
  expect(await zellij.log()).toEqual(["action query-tab-names"])
})

function rendererWithRender(events: string[]) {
  return {
    ...renderer(events),
    requestRender() {
      events.push("render")
    },
  }
}

test("normalizes a single trailing editor newline for one-line prompts", () => {
  expect(normalizePromptContent("hello\n")).toBe("hello")
  expect(normalizePromptContent("hello\r\n")).toBe("hello")
})

test("preserves multiline prompts that end with a newline", () => {
  expect(normalizePromptContent("hello\nworld\n")).toBe("hello\nworld\n")
})
