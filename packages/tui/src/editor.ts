import type { CliRenderer } from "@opentui/core"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"
import type { Stream } from "node:stream"
import { resolveZedDbPath, resolveZedSelection } from "./editor-zed"

type EditorStdio = "inherit" | "pipe" | "ignore" | number | Stream

export function normalizePromptContent(content: string) {
  if (content.endsWith("\r\n")) {
    const body = content.slice(0, -2)
    return !body.includes("\n") && !body.includes("\r") ? body : content
  }

  if (content.endsWith("\n")) {
    const body = content.slice(0, -1)
    return !body.includes("\n") && !body.includes("\r") ? body : content
  }

  return content
}

export async function openEditor(input: { value: string; renderer: CliRenderer; cwd?: string; stdin?: EditorStdio }) {
  const editor = process.env.VISUAL || process.env.EDITOR
  if (!editor) return
  const file = path.join(os.tmpdir(), `${Date.now()}.md`)
  await writeFile(file, input.value)
  const cwd = input.cwd && existsSync(input.cwd) ? input.cwd : process.cwd()

  // Inside zellij, open the editor in a split (tiled) pane instead of suspending
  // the renderer. Suspending would leave the alternate screen and hide the
  // session transcript, so the reply above is no longer visible while editing.
  // A tiled split stacks opencode above the editor, both fully visible without
  // overlap, and leaves any existing floating panes untouched (still reachable
  // via alt+f). `--block-until-exit` preserves the read-back-after-edit
  // semantics.
  if (process.env.ZELLIJ !== undefined) {
    return openEditorInZellij({ editor, file, cwd, renderer: input.renderer })
  }

  input.renderer.suspend()
  input.renderer.currentRenderBuffer.clear()
  try {
    await new Promise<void>((resolve, reject) => {
      const parts = editor.split(" ")
      const child = spawn(parts[0]!, [...parts.slice(1), file], {
        cwd,
        stdio: [input.stdin ?? "inherit", "inherit", "inherit"],
        shell: process.platform === "win32",
      })
      child.on("error", reject)
      child.on("exit", (code, signal) => {
        if (code === 0) return resolve()
        reject(new Error(`Editor exited with ${signal ? `signal ${signal}` : `code ${code}`}`))
      })
    })
    return (await readFile(file, "utf8")) || undefined
  } finally {
    await rm(file, { force: true }).catch(() => {})
    input.renderer.currentRenderBuffer.clear()
    input.renderer.resume()
    input.renderer.requestRender()
  }
}

async function openEditorInZellij(input: { editor: string; file: string; cwd: string; renderer: CliRenderer }) {
  const paneID = process.env.ZELLIJ_PANE_ID
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        "zellij",
        [
          "run",
          "--direction",
          "down",
          "--close-on-exit",
          "--block-until-exit",
          "--cwd",
          input.cwd,
          "--",
          // The pane opens split evenly; shrink it a few times so the editor
          // takes roughly a third and most of opencode's reply stays visible.
          // editor/file are passed as positional args to avoid shell escaping.
          "sh",
          "-c",
          "zellij action resize decrease up; zellij action resize decrease up; zellij action resize decrease up; exec \"$@\"",
          "sh",
          ...input.editor.split(" "),
          input.file,
        ],
        { stdio: "ignore" },
      )
      child.on("error", reject)
      child.on("exit", (code, signal) => {
        if (code === 0) return resolve()
        reject(new Error(`Editor exited with ${signal ? `signal ${signal}` : `code ${code}`}`))
      })
    })
    return (await readFile(input.file, "utf8")) || undefined
  } finally {
    await rm(input.file, { force: true }).catch(() => {})
    // The editor pane closes on exit; focus back to our own pane so the prompt
    // is active again instead of whichever pane zellij falls back to.
    if (paneID) await refocusZellijPane(paneID)
    input.renderer.requestRender()
  }
}

function refocusZellijPane(paneID: string) {
  return new Promise<void>((resolve) => {
    const child = spawn("zellij", ["action", "focus-pane-id", paneID], { stdio: "ignore" })
    child.on("error", () => resolve())
    child.on("exit", () => resolve())
  })
}

export function discoverEditorConnection(directory: string) {
  const root = path.join(os.homedir(), ".claude", "ide")
  const contains = (parent: string) => {
    const resolved = path.resolve(parent)
    const relative = path.relative(resolved, path.resolve(directory))
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative)) ? resolved.length : 0
  }
  try {
    return readdirSync(root)
      .filter((entry) => entry.endsWith(".lock"))
      .flatMap((entry) => {
        const file = path.join(root, entry)
        const port = Number.parseInt(path.basename(file, ".lock"), 10)
        if (!Number.isInteger(port) || port <= 0 || port > 65535) return []
        try {
          const value = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>
          if (value.transport !== undefined && value.transport !== "ws") return []
          const folders = Array.isArray(value.workspaceFolders)
            ? value.workspaceFolders.filter((item): item is string => typeof item === "string")
            : []
          const score = Math.max(0, ...folders.map(contains))
          if (!score) return []
          return [
            {
              url: `ws://127.0.0.1:${port}`,
              authToken: typeof value.authToken === "string" ? value.authToken : undefined,
              source: `lock:${port}`,
              score,
              mtime: statSync(file).mtimeMs,
            },
          ]
        } catch {
          return []
        }
      })
      .sort((left, right) => right.score - left.score || right.mtime - left.mtime)
      .map(({ url, authToken, source }) => ({ url, authToken, source }))[0]
  } catch {
    return undefined
  }
}

export const editorIntegration = {
  connection: discoverEditorConnection,
  selection: (directory: string) => resolveZedSelection(resolveZedDbPath() ?? "", directory),
}
