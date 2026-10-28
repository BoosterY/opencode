/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { onMount } from "solid-js"
import { ToastProvider, useToast, type ToastContext } from "../../../src/ui/toast"
import { ConfigProvider } from "../../../src/config"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"

function captureToast(setToast: (toast: ToastContext) => void) {
  return function Capture() {
    const toast = useToast()
    onMount(() => setToast(toast))
    return null
  }
}

test("activation runs an action and keeps a queued toast paused", async () => {
  let toast: ToastContext | undefined
  const Capture = captureToast((value) => (toast = value))
  const app = await testRender(() => (
    <ToastProvider>
      <Capture />
    </ToastProvider>
  ))

  try {
    await app.waitFor(() => toast !== undefined)
    let activated = false
    toast!.show({
      message: "Plugin failed",
      variant: "error",
      action: { label: "Open plugins", run: () => (activated = true) },
    })
    toast!.pause()
    toast!.show({ message: "Copied", variant: "success", duration: 5 })

    expect(toast!.currentToast?.message).toBe("Plugin failed")
    expect(toast!.pending).toBe(1)

    toast!.activate()

    expect(activated).toBe(true)
    expect(toast!.currentToast?.message).toBe("Copied")
    expect(toast!.pending).toBe(0)

    await Bun.sleep(10)
    expect(toast!.currentToast?.message).toBe("Copied")

    toast!.resume()
    await Bun.sleep(10)
    expect(toast!.currentToast).toBeNull()
  } finally {
    app.renderer.destroy()
  }
})

test("activation dismisses a toast without an action", async () => {
  let toast: ToastContext | undefined
  const Capture = captureToast((value) => (toast = value))
  const app = await testRender(() => (
    <ToastProvider>
      <Capture />
    </ToastProvider>
  ))

  try {
    await app.waitFor(() => toast !== undefined)
    toast!.show({ message: "Copied", variant: "success", duration: 5 })
    toast!.activate()
    expect(toast!.currentToast).toBeNull()
  } finally {
    app.renderer.destroy()
  }
})

test.each([
  { copy_toast: undefined, shown: false },
  { copy_toast: false, shown: false },
  { copy_toast: true, shown: true },
])("clipboard toasts follow terminal.copy_toast=$copy_toast", async ({ copy_toast, shown }) => {
  let toast: ToastContext | undefined
  const Capture = captureToast((value) => (toast = value))
  const app = await testRender(() => (
    <ConfigProvider config={createTuiResolvedConfig({ terminal: { copy_toast } })}>
      <ToastProvider>
        <Capture />
      </ToastProvider>
    </ConfigProvider>
  ))

  try {
    await app.waitFor(() => toast !== undefined)
    toast!.show({ message: "Copied", variant: "info", clipboard: true })
    expect(toast!.currentToast?.message).toBe(shown ? "Copied" : undefined)
    toast!.dismiss()
    // Non-clipboard toasts are never gated.
    toast!.show({ message: "Failed", variant: "error" })
    expect(toast!.currentToast?.message).toBe("Failed")
  } finally {
    app.renderer.destroy()
  }
})
