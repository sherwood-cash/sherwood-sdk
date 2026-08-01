// Node proof generation. snarkjs.groth16.fullProve takes file paths in Node (unlike the
// browser build, which fetches URLs). The circuit artifacts are large (wasm ~3 MB, zkey
// ~16 MB), so they're not bundled — they're downloaded once to a cache dir on first use.
// Override with SHERWOOD_WASM_PATH / SHERWOOD_ZKEY_PATH to run fully offline.
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, statSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { toFixedHex } from './crypto/utils.js'

// snarkjs / ffjavascript ship as CommonJS; require them from an ESM context.
const require = createRequire(import.meta.url)
const { groth16, zKey } = require('snarkjs')
const { utils: ffutils } = require('ffjavascript')

const DEFAULT_WASM_URL = 'https://sherwood.cash/circuits/transaction2.wasm'
const DEFAULT_ZKEY_URL = 'https://sherwood.cash/circuits/transaction2.zkey'

export interface SolidityProof {
  pA: [string, string]
  pB: [[string, string], [string, string]]
  pC: [string, string]
}

export interface ProverArtifacts {
  /** Local path or URL to transaction2.wasm. Defaults to the public Sherwood CDN. */
  wasm?: string
  /** Local path or URL to transaction2.zkey. Defaults to the public Sherwood CDN. */
  zkey?: string
  /** Directory used to cache downloaded artifacts. */
  cacheDir?: string
}

function cacheRoot(custom?: string): string {
  if (custom) return custom
  const base = process.env.SHERWOOD_CACHE_DIR || join(homedir() || tmpdir(), '.sherwood-sdk')
  const dir = join(base, 'circuits')
  mkdirSync(dir, { recursive: true })
  return dir
}

async function download(url: string, dest: string): Promise<string> {
  if (existsSync(dest) && statSync(dest).size > 0) return dest
  const res = await fetch(url)
  if (!res.ok) throw new Error(`failed to download circuit artifact ${url}: ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  await writeFile(dest, buf)
  return dest
}

// Resolve a wasm/zkey reference (env override → explicit path/URL → default URL) to a
// local file path snarkjs can read.
async function resolve(ref: string | undefined, envVar: string, defUrl: string, name: string, cacheDir?: string): Promise<string> {
  const src = process.env[envVar] || ref || defUrl
  if (!/^https?:\/\//.test(src)) {
    if (!existsSync(src)) throw new Error(`circuit artifact not found at ${src}`)
    return src
  }
  return download(src, join(cacheRoot(cacheDir), name))
}

let resolved: { wasm: string; zkey: string } | null = null

/** Pre-fetch the circuit artifacts (optional; prove() does this lazily). */
export async function ensureArtifacts(a: ProverArtifacts = {}): Promise<{ wasm: string; zkey: string }> {
  if (resolved) return resolved
  const [wasm, zkey] = await Promise.all([
    resolve(a.wasm, 'SHERWOOD_WASM_PATH', DEFAULT_WASM_URL, 'transaction2.wasm', a.cacheDir),
    resolve(a.zkey, 'SHERWOOD_ZKEY_PATH', DEFAULT_ZKEY_URL, 'transaction2.zkey', a.cacheDir),
  ])
  resolved = { wasm, zkey }
  return resolved
}

// The verification key, exported once from the zkey and cached — used to check every
// proof locally before it ever reaches the relayer.
let vkeyPromise: Promise<any> | null = null
async function verificationKey(zkeyPath: string): Promise<any> {
  if (!vkeyPromise) vkeyPromise = zKey.exportVerificationKey(zkeyPath)
  return vkeyPromise
}

/**
 * Generate a Groth16 proof and, unless `verify` is false, check it locally with
 * groth16.verify BEFORE returning — a malformed proof should fail here, in-process, not
 * at the relayer or (worse) silently on-chain.
 */
export async function prove(
  input: Record<string, any>,
  artifacts: ProverArtifacts = {},
  verify = true,
): Promise<SolidityProof> {
  const { wasm, zkey } = await ensureArtifacts(artifacts)
  const { proof, publicSignals } = await groth16.fullProve(ffutils.stringifyBigInts(input), wasm, zkey)
  if (verify) {
    const ok = await groth16.verify(await verificationKey(zkey), publicSignals, proof)
    if (!ok) throw new Error('generated proof failed local verification — refusing to submit')
  }
  const pA: [string, string] = [toFixedHex(proof.pi_a[0]), toFixedHex(proof.pi_a[1])]
  const pB: [[string, string], [string, string]] = [
    [toFixedHex(proof.pi_b[0][1]), toFixedHex(proof.pi_b[0][0])],
    [toFixedHex(proof.pi_b[1][1]), toFixedHex(proof.pi_b[1][0])],
  ]
  const pC: [string, string] = [toFixedHex(proof.pi_c[0]), toFixedHex(proof.pi_c[1])]
  return { pA, pB, pC }
}
