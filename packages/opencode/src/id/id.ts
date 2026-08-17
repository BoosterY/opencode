import { randomBytes } from "crypto"

const prefixes = {
  job: "job",
  event: "evt",
  session: "ses",
  message: "msg",
  permission: "per",
  question: "que",
  part: "prt",
  pty: "pty",
  tool: "tool",
  workspace: "wrk",
} as const

const LENGTH = 26

// State for monotonic ID generation
let lastTimestamp = 0
let counter = 0

export function ascending(prefix: keyof typeof prefixes, given?: string) {
  return generateID(prefix, "ascending", given)
}

export function descending(prefix: keyof typeof prefixes, given?: string) {
  return generateID(prefix, "descending", given)
}

function generateID(prefix: keyof typeof prefixes, direction: "descending" | "ascending", given?: string): string {
  if (!given) {
    return create(prefixes[prefix], direction)
  }

  if (!given.startsWith(prefixes[prefix])) {
    throw new Error(`ID ${given} does not start with ${prefixes[prefix]}`)
  }
  return given
}

function randomBase62(length: number): string {
  const chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
  let result = ""
  const bytes = randomBytes(length)
  for (let i = 0; i < length; i++) {
    result += chars[bytes[i] % 62]
  }
  return result
}

export function create(prefix: string, direction: "descending" | "ascending", timestamp?: number): string {
  const currentTimestamp = timestamp ?? Date.now()

  if (currentTimestamp !== lastTimestamp) {
    lastTimestamp = currentTimestamp
    counter = 0
  }
  counter++

  let now = BigInt(currentTimestamp) * BigInt(0x1000) + BigInt(counter)

  now = direction === "descending" ? ~now : now

  const timeBytes = Buffer.alloc(6)
  for (let i = 0; i < 6; i++) {
    timeBytes[i] = Number((now >> BigInt(40 - 8 * i)) & BigInt(0xff))
  }

  return prefix + "_" + timeBytes.toString("hex") + randomBase62(LENGTH - 12)
}

/** Extract timestamp from an ascending ID. Does not work with descending IDs. */
export function timestamp(id: string): number {
  const prefix = id.split("_")[0]
  const hex = id.slice(prefix.length + 1, prefix.length + 13)
  const encoded = BigInt("0x" + hex)
  return Number(encoded / BigInt(0x1000))
}

/**
 * The encoded time field is 6 bytes (48 bits) holding `timestamp * 0x1000 + counter`.
 * That product outgrew 48 bits on 2026-08-14T11:19:55.136Z, so the field silently
 * wraps every 2^36 ms (~2.2 years): IDs minted after a wrap sort lexicographically
 * BELOW those minted before it. Comparing two IDs with `<` is therefore not a valid
 * chronological test across a wrap boundary — it made `SessionPrompt.runLoop` treat
 * a fresh user message as already-answered and exit without calling the model.
 *
 * Widening the field would change ID length and invalidate every stored ID, so
 * compare through this helper instead: it reads the field as a circular counter,
 * where a gap wider than half the period means a wrap, not a 1.1-year jump.
 */
const PERIOD = BigInt(1) << BigInt(48)
const HALF_PERIOD = PERIOD >> BigInt(1)

/** Raw 48-bit time field of an ascending ID. */
function encoded(id: string): bigint {
  const underscore = id.indexOf("_")
  return BigInt("0x" + id.slice(underscore + 1, underscore + 13))
}

/**
 * Chronological comparison of two ascending IDs, tolerant of the 48-bit wrap.
 * `<0` if `a` predates `b`, `>0` if `a` is newer, `0` if identical.
 * Usable directly as an Array#sort comparator.
 */
export function compare(a: string, b: string): number {
  const diff = (encoded(a) - encoded(b) + PERIOD) % PERIOD
  if (diff === BigInt(0)) return 0
  return diff < HALF_PERIOD ? 1 : -1
}

export * as Identifier from "./id"
