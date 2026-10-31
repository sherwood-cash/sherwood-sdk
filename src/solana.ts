// Client for the Sherwood Solana program (zkcash, spec v2). Same circuit, same keys as the
// EVM vault: the prover, Utxo, Keypair and selectNotes are reused from ./crypto. What
// differs on Solana, and lives here:
//   - mintField: the commitment's 4th input. SOL = the decimal number
//     11111111111111111111111111111112, SPL = the mint's first 31 bytes big-endian.
//     Everywhere else (PDAs, extDataHash, events) SOL is the wSOL mint.
//   - trees per (mint, epoch); NewCommitment.index is global: epoch * 2^26 + local.
//     A spend proves against ONE root, so both inputs come from one epoch (`inEpoch`).
//   - extDataHash: sha256 of a borsh struct, read LITTLE-endian mod p. The program
//     recomputes it and public_amount itself; the client proves with the same values.
//   - SpendProof: Groth16 points COMPRESSED (alt_bn128 syscall format).
//   - note blobs: compact binary, AES-256-GCM [iv 12][tag 16][ct]; zero notes too (fixed 68 bytes).
//   - fees: protocol (global_config bps) and relayer (params.relayer.fee); the protocol also takes
//     fee_on(relayer fee) out of the relayer's leg, so the user pays the quoted relayer fee and no more.
//
// Deposits are signed by the user's wallet. Withdrawals, swaps and quote merges are proved
// here and POSTed to /solana/relay, so the fee payer never links the exit to the wallet.
//
// Relay payload (POST /solana/relay) = Plan, all JSON:
//   { kind, args, accounts, remainingAccounts?, addressLookupTables? }
//   args: the instruction's args, camelCase as Anchor's TS client names them. Fixed byte
//         arrays and Vec<u8> are number[]; u64/i64 are decimal strings.
//   accounts: camelCase account name -> base58. `signer` (the relayer) is left out, and so
//         are unused optional accounts. remainingAccounts: [{ pubkey, isWritable }].
import { BigNumber, ethers } from 'ethers'
import { MerkleTree } from 'fixed-merkle-tree'
import {
  ComputeBudgetProgram,
  Connection,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
  type AddressLookupTableAccount,
  type Transaction,
  type TransactionInstruction,
} from '@solana/web3.js'
import { ASSOCIATED_TOKEN_PROGRAM_ID, NATIVE_MINT, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token'
import anchor from '@coral-xyz/anchor'
import type { Idl } from '@coral-xyz/anchor'
import idl from './solana/zkcash.json' with { type: 'json' }
import { Utxo } from './crypto/utxo.js'
import { Keypair, deriveSwapKeypair as deriveTemporaryKeypair } from './crypto/keypair.js'
import { SIGN_IN_MESSAGE, deriveKeys } from './crypto/encryption.js'
import { prove, type ProverArtifacts, type SolidityProof } from './prover.js'
import { FIELD_SIZE, MERKLE_TREE_HEIGHT, poseidonHash2, toFixedHex } from './crypto/utils.js'
import { selectNotes } from './tree.js'
import { DEFAULT_API_URL } from './config.js'

const { BN, Program } = anchor

export interface Keys {
  encryptionKey: Uint8Array
  keypair: Keypair
}

/** Module-wide Solana settings; call configureSolana() before anything else to override. */
export interface SolanaConfig {
  /** Backend base URL (without /solana). */
  apiUrl: string
  /** Solana RPC; default derived from the backend's cluster. */
  rpcUrl?: string
  /** Pinned program id: params naming another program are refused. Empty = trust the backend. */
  programId: string
  /** Circuit artifacts for the prover (same circuit as the EVM vault). */
  artifacts?: ProverArtifacts
}
const SOLANA: SolanaConfig = { apiUrl: DEFAULT_API_URL, programId: '' }

export function configureSolana(c: Partial<SolanaConfig>): void {
  Object.assign(SOLANA, c)
  paramsCache = null
}

function solanaRpcUrl(cluster: string): string {
  if (SOLANA.rpcUrl) return SOLANA.rpcUrl
  if (cluster === 'localnet') return 'http://127.0.0.1:8899'
  const mainnet = cluster === 'mainnet-beta' || cluster === 'mainnet'
  return `https://api.${mainnet ? 'mainnet-beta' : cluster}.solana.com`
}
export type SolanaNote = Utxo

export interface SolanaMint {
  mint: string
  symbol: string
  decimals: number
  native: boolean
  /** Only quotes may be deposited, withdrawn or pay a fee. */
  quote: boolean
  swapAllowed: boolean
  /** Live epoch when the params were read (the trees status is authoritative). */
  epoch: number
  /** Owner of the mint account: SPL Token or Token-2022. From the backend, else read over RPC by resolve(). */
  tokenProgram?: string
}

export interface SolanaParams {
  cluster: string
  programId: string
  swapProgramId: string
  altAddress: string | null
  permissionlessSwaps: boolean
  fees: { withdrawFeeBps: number; swapFeeBps: number; feeRecipient: string }
  /** The relayer's wallet and its fee per QUOTE mint, in base units; null when not configured. */
  relayer: { address: string; fee: Record<string, string> } | null
  assets: SolanaMint[]
  /** Same as `assets` (v1 name). */
  mints: SolanaMint[]
  /** Same as `fees.withdrawFeeBps` / `fees.feeRecipient` (v1 names). */
  withdrawFeeBps: number
  feeRecipient: string
}

export interface FeePart {
  mint: string
  amount: bigint
}

export interface SwapQuote {
  amountIn: bigint
  /** What reaches the DEX: amountIn minus the input protocol fee when mintIn is a quote. */
  routeAmountIn: bigint
  /** DEX output before any output fee. */
  rawOut: bigint
  /** Net amount of the output note, after every fee, at the quoted price. */
  amountOut: bigint
  /** min_out at zero slippage (= amountOut); swap() lowers it by its slippage. */
  minOut: bigint
  protocolFee: FeePart
  relayerFee: FeePart
  /** base64 instruction data for the DEX program. */
  routeData: string
  remainingAccounts: { pubkey: string; isWritable: boolean }[]
  swapProgramId: string
  /** Lookup tables for this route (Jupiter on mainnet); forwarded to the relay. */
  addressLookupTables?: string[]
}

export interface SolanaWallet {
  publicKey: PublicKey
  signTransaction<T extends Transaction | VersionedTransaction>(tx: T): Promise<T>
}

/** Circuit-side mint of SOL notes. On-chain, SOL is the wSOL mint. */
export const SOL_ADDRESS = new PublicKey('11111111111111111111111111111112')
export const TREE_CAPACITY = 2 ** MERKLE_TREE_HEIGHT

// ---------------------------------------------------------------- backend

function apiUrl(path: string): string {
  const b = SOLANA.apiUrl.trim().replace(/\/+$/, '')
  if (!b) throw new Error('Solana backend not configured')
  return `${b}/solana${path}`
}

async function api(path: string, body?: unknown): Promise<any> {
  const res = await fetch(apiUrl(path), {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!res.ok) {
    let detail = `${res.status} ${res.statusText}`
    let code: string | undefined
    try {
      const j = await res.json()
      code = j?.error
      if (j?.reason || j?.error || j?.message) detail = j.reason || j.error || j.message
    } catch {
      /* non-JSON error body */
    }
    throw new SolanaApiError(`Solana ${path}: ${detail}`, res.status, code)
  }
  return res.json()
}

/** A non-2xx from the backend; `status` 503 = that part of the backend is not configured. */
export class SolanaApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message)
  }
}

/** The notes cannot be spent together: merge() them into the live epoch first. */
export class SolanaMergeRequired extends Error {
  constructor(readonly mint: string) {
    super('Shielded balance is split across epochs or notes: merge your notes first')
  }
}

// Mainnet quotes, so the UI names them right even when the backend omits a symbol.
const KNOWN_SYMBOLS: Record<string, string> = {
  So11111111111111111111111111111111111111112: 'SOL',
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: 'USDC',
  '42gnPdvUrRgHyAkt6dXtwLd84HwX14CtwCx4wS6gjN33': 'SHERWOOD',
}

/** GET /solana/params as returned by the backend -> SolanaParams (with the v1 aliases). */
export function toSolanaParams(raw: any): SolanaParams {
  const assets: SolanaMint[] = (raw.assets ?? []).map((a: any) => ({
    mint: a.mint, symbol: a.symbol || KNOWN_SYMBOLS[a.mint] || a.mint.slice(0, 4), decimals: a.decimals, native: !!a.native,
    quote: !!a.quote, swapAllowed: !!a.swapAllowed, epoch: Number(a.epoch ?? 0),
    ...(a.tokenProgram && { tokenProgram: a.tokenProgram }),
  }))
  const fees = {
    withdrawFeeBps: Number(raw.fees?.withdrawFeeBps ?? 0),
    swapFeeBps: Number(raw.fees?.swapFeeBps ?? 0),
    feeRecipient: raw.fees?.feeRecipient ?? PublicKey.default.toBase58(),
  }
  return {
    cluster: raw.cluster, programId: raw.programId, swapProgramId: raw.swapProgramId,
    altAddress: raw.altAddress ?? null, permissionlessSwaps: !!raw.permissionlessSwaps,
    fees, relayer: raw.relayer ?? null, assets, mints: assets,
    withdrawFeeBps: fees.withdrawFeeBps, feeRecipient: fees.feeRecipient,
  }
}

let paramsCache: Promise<SolanaParams> | null = null

export function getSolanaParams(): Promise<SolanaParams> {
  paramsCache ??= api('/params').then((raw) => checkProgramId(toSolanaParams(raw))).catch((e) => {
    paramsCache = null
    throw e
  })
  return paramsCache
}

/** Refuses params naming another program than the pinned SolanaConfig.programId (a hostile backend could redirect deposits). */
export function checkProgramId(params: SolanaParams, pinned: string = SOLANA.programId): SolanaParams {
  if (pinned && params.programId !== pinned) throw new Error(`Solana params name program ${params.programId}, expected ${pinned}`)
  return params
}

export function solanaConnection(params: SolanaParams): Connection {
  return new Connection(solanaRpcUrl(params.cluster), 'confirmed')
}

/** Fills each asset's tokenProgram from its mint account owner when the backend left it out. */
export async function withTokenPrograms(params: SolanaParams, conn: Connection): Promise<SolanaParams> {
  const missing = params.assets.filter((a) => !a.tokenProgram && !isNative(normalizeMint(a.mint)))
  if (!missing.length) return params
  const infos = await conn.getMultipleAccountsInfo(missing.map((a) => normalizeMint(a.mint)))
  const owners = new Map(missing.map((a, i) => {
    const owner = infos[i]?.owner
    if (!owner) throw new Error(`Solana: mint ${a.mint} not found`)
    return [a.mint, owner.toBase58()]
  }))
  const assets = params.assets.map((a) => (owners.has(a.mint) ? { ...a, tokenProgram: owners.get(a.mint) } : a))
  return { ...params, assets, mints: assets }
}

// ---------------------------------------------------------------- encoding

const isNative = (mint: PublicKey) => mint.equals(NATIVE_MINT) || mint.equals(SOL_ADDRESS)

/** 'SOL', the wSOL mint or the system id all mean the SOL pool; returns the on-chain mint. */
export function normalizeMint(mint: string | PublicKey): PublicKey {
  if (mint === 'SOL') return NATIVE_MINT
  const pk = new PublicKey(mint)
  return isNative(pk) ? NATIVE_MINT : pk
}

/** The commitment's mint input, identical to pool.rs::mint_field. */
export function mintField(mint: string | PublicKey): BigNumber {
  const m = normalizeMint(mint)
  if (isNative(m)) return BigNumber.from(SOL_ADDRESS.toBase58())
  return BigNumber.from(m.toBytes().slice(0, 31))
}

/** A NewCommitment index -> the tree it lives in and its leaf (circuit path) index. */
export function splitIndex(index: number | bigint | string): { epoch: number; local: number } {
  const i = BigInt(index)
  const cap = BigInt(TREE_CAPACITY)
  return { epoch: Number(i / cap), local: Number(i % cap) }
}

const hexBytes = (h: string) => ethers.utils.arrayify(h.startsWith('0x') ? h : '0x' + h)
const be32 = (v: BigNumber | string | bigint) => Array.from(ethers.utils.arrayify(toFixedHex(BigNumber.from(v.toString()))))

function u64le(v: bigint): Uint8Array {
  const out = new Uint8Array(8)
  let x = BigInt.asUintN(64, v)
  for (let i = 0; i < 8; i++, x >>= 8n) out[i] = Number(x & 0xffn)
  return out
}
const borshVec = (b: Uint8Array) => ethers.utils.concat([u64le(BigInt(b.length)).slice(0, 4), b])

/** sha256 digest read little-endian mod p: what the circuit's extDataHash must be. */
function leField(bytes: ethers.utils.BytesLike): BigNumber {
  const digest = ethers.utils.arrayify(ethers.utils.sha256(bytes))
  return BigNumber.from(digest.reverse()).mod(FIELD_SIZE)
}

export interface ExtData {
  recipient: PublicKey
  extAmount: bigint
  encryptedOutput1: Uint8Array
  encryptedOutput2: Uint8Array
  /** Relayer fee only. */
  fee: bigint
  feeRecipient: PublicKey
  /** On-chain mint (wSOL for SOL). */
  mintAddress: PublicKey
}

function extDataBytes(e: ExtData): Uint8Array {
  return ethers.utils.concat([
    e.recipient.toBytes(),
    u64le(e.extAmount),
    borshVec(e.encryptedOutput1),
    borshVec(e.encryptedOutput2),
    u64le(e.fee),
    e.feeRecipient.toBytes(),
    normalizeMint(e.mintAddress).toBytes(),
  ])
}

/** pool.rs::transact_ext_data_hash, as a field element (transact / transact_spl). */
export function extDataHash(e: ExtData): BigNumber {
  return leField(extDataBytes(e))
}

export interface SwapParams {
  /** Floor on the NET output, after every fee. */
  minOut: bigint
  deadline: bigint
  relayerFeeOut: bigint
  outPubkey: Uint8Array
  outBlinding: Uint8Array
  encryptedOutput: Uint8Array
  routeData: Uint8Array
}

/** swap.rs::swap_ext_data_hash. e.recipient = escrow_in, e.feeRecipient = relayer_in, e.mintAddress = mint_in. */
export function swapExtDataHash(e: ExtData, mintOut: PublicKey, swapProgram: PublicKey, relayerOut: PublicKey, p: SwapParams): BigNumber {
  return leField(
    ethers.utils.concat([
      extDataBytes(e),
      normalizeMint(mintOut).toBytes(),
      swapProgram.toBytes(),
      relayerOut.toBytes(),
      u64le(p.minOut),
      u64le(p.deadline),
      u64le(p.relayerFeeOut),
      p.outPubkey,
      p.outBlinding,
      borshVec(p.encryptedOutput),
      borshVec(p.routeData),
    ]),
  )
}

// Point compression in the alt_bn128 syscall format (port of the contracts'
// tests/lib/compress.ts): big-endian x, bit 7 of the first byte set when y > -y; for G2
// compare y.c1 first, y.c0 when it is 0. Input: G1 = x||y, G2 = x.c1||x.c0||y.c1||y.c0.
const FQ = 21888242871839275222246405745257275088696311157297823662689037894645226208583n
const toBig = (b: Uint8Array) => BigInt(ethers.utils.hexlify(b))
const isNegY = (v: bigint) => v > (v === 0n ? 0n : FQ - v)

export function compressG1(point: Uint8Array | number[]): number[] {
  const b = Uint8Array.from(point)
  if (b.every((x) => x === 0)) return new Array(32).fill(0)
  const out = Array.from(b.subarray(0, 32))
  if (isNegY(toBig(b.subarray(32, 64)))) out[0] |= 0x80
  return out
}

export function compressG2(point: Uint8Array | number[]): number[] {
  const b = Uint8Array.from(point)
  if (b.every((x) => x === 0)) return new Array(64).fill(0)
  const out = Array.from(b.subarray(0, 64))
  const y1 = toBig(b.subarray(64, 96))
  const y0 = toBig(b.subarray(96, 128))
  if (y1 !== 0n ? isNegY(y1) : isNegY(y0)) out[0] |= 0x80
  return out
}

/** The program's SpendProof: compressed points, root, nullifiers, commitments, all big-endian. */
export function packProof(
  p: SolidityProof,
  pub: { root: BigNumber; inputNullifiers: BigNumber[]; outputCommitments: BigNumber[] },
) {
  const cat = (xs: string[]) => xs.flatMap((x) => be32(x))
  return {
    proofA: compressG1(cat(p.pA)),
    proofB: compressG2(cat(p.pB.flat())),
    proofC: compressG1(cat(p.pC)),
    root: be32(pub.root),
    inputNullifiers: pub.inputNullifiers.map(be32),
    outputCommitments: pub.outputCommitments.map(be32),
  }
}
export type ProofBytes = ReturnType<typeof packProof>

// ---------------------------------------------------------------- note blobs

async function aesKey(key: Uint8Array) {
  return crypto.subtle.importKey('raw', key as BufferSource, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
}

/** AES-256-GCM, framed [iv 12][tag 16][ciphertext] like the EVM blobs. */
export async function sealBlob(key: Uint8Array, plain: Uint8Array): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ctTag = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aesKey(key), plain as BufferSource))
  const tag = ctTag.slice(ctTag.length - 16)
  return ethers.utils.concat([iv, tag, ctTag.slice(0, ctTag.length - 16)])
}

export async function openBlob(key: Uint8Array, blob: Uint8Array): Promise<Uint8Array> {
  const ct = ethers.utils.concat([blob.slice(28), blob.slice(12, 28)])
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: blob.slice(0, 12) as BufferSource }, await aesKey(key), ct as BufferSource))
}

const be = (v: BigNumber, n: number) => ethers.utils.zeroPad(ethers.utils.arrayify(v), n)

/** Note: [0x01][amount u64 BE][blinding 31 BE] (68 bytes sealed), zero notes included so blob sizes leak nothing. */
export async function encryptNote(key: Uint8Array, u: Utxo): Promise<Uint8Array> {
  return sealBlob(key, ethers.utils.concat([[1], be(u.amount, 8), be(u.blinding, 31)]))
}

/** Swap output: [0x02][blinding 31 BE] (60 bytes sealed); the amount comes from SwapExecuted. */
export async function encryptSwapOutput(key: Uint8Array, blinding: BigNumber): Promise<Uint8Array> {
  return sealBlob(key, ethers.utils.concat([[2], be(blinding, 31)]))
}

export type DecodedBlob = { kind: 'note'; amount: BigNumber; blinding: BigNumber } | { kind: 'swap'; blinding: BigNumber }

/** null when the blob is empty, not ours, or not a known format. */
export async function decryptBlob(key: Uint8Array, blob: Uint8Array): Promise<DecodedBlob | null> {
  if (blob.length <= 28) return null
  let p: Uint8Array
  try {
    p = await openBlob(key, blob)
  } catch {
    return null
  }
  if (p[0] === 1 && p.length === 40) return { kind: 'note', amount: BigNumber.from(p.slice(1, 9)), blinding: BigNumber.from(p.slice(9)) }
  if (p[0] === 2 && p.length === 32) return { kind: 'swap', blinding: BigNumber.from(p.slice(1)) }
  return null
}

// ---------------------------------------------------------------- PDAs

export function pdas(programId: string | PublicKey) {
  const pid = new PublicKey(programId)
  const pda = (...seeds: Uint8Array[]) => PublicKey.findProgramAddressSync(seeds, pid)[0]
  const s = (t: string) => new TextEncoder().encode(t)
  const u32 = (n: number) => Uint8Array.from([n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff])
  const globalConfig = pda(s('global_config'))
  const solPool = pda(s('sol_pool'))
  /** `prog`: the mint's token program (tokenProgramOf); SPL Token when omitted. */
  const ata = (mint: PublicKey, owner: PublicKey, prog: PublicKey = TOKEN_PROGRAM_ID) => getAssociatedTokenAddressSync(mint, owner, true, prog)
  return {
    globalConfig,
    solPool,
    swapAuthority: pda(s('swap_authority')),
    eventAuthority: pda(s('__event_authority')),
    ata,
    asset: (mint: PublicKey) => pda(s('asset'), normalizeMint(mint).toBytes()),
    tree: (mint: PublicKey, epoch: number) => pda(s('merkle_tree'), normalizeMint(mint).toBytes(), u32(epoch)),
    swapEntry: (program: PublicKey) => pda(s('swap_program'), program.toBytes()),
    pool: (mint: PublicKey, prog?: PublicKey) => (isNative(mint) ? solPool : ata(normalizeMint(mint), globalConfig, prog)),
    /** Wallet for SOL, its ATA otherwise: the shape of every relayer / protocol fee account. */
    acct: (mint: PublicKey, owner: PublicKey, prog?: PublicKey) => (isNative(mint) ? owner : ata(normalizeMint(mint), owner, prog)),
    nullifiers: (n: number[][]) => ({
      nullifier0: pda(s('nullifier0'), Uint8Array.from(n[0])),
      nullifier1: pda(s('nullifier1'), Uint8Array.from(n[1])),
      nullifier2: pda(s('nullifier0'), Uint8Array.from(n[1])),
      nullifier3: pda(s('nullifier1'), Uint8Array.from(n[0])),
    }),
  }
}

// ---------------------------------------------------------------- fees (as the program)

const assetOf = (params: SolanaParams, mint: PublicKey) => {
  const m = normalizeMint(mint)
  const a = params.assets.find((x) => normalizeMint(x.mint).equals(m))
  if (!a) throw new Error(`Solana: ${m.toBase58()} is not a configured asset`)
  return a
}
/** The mint's token program: SPL Token for SOL/wSOL, else the asset's tokenProgram. */
export function tokenProgramOf(params: SolanaParams, mint: string | PublicKey): PublicKey {
  const m = normalizeMint(mint)
  if (isNative(m)) return TOKEN_PROGRAM_ID
  const tp = assetOf(params, m).tokenProgram
  return tp ? new PublicKey(tp) : TOKEN_PROGRAM_ID
}
const isQuote = (params: SolanaParams, mint: PublicKey) => isNative(normalizeMint(mint)) || assetOf(params, mint).quote

/** pool.rs::fee_on: 0 when the rate is 0 or no fee recipient is set. */
export function protocolFee(params: SolanaParams, amount: bigint, bps: number): bigint {
  if (!bps || new PublicKey(params.fees.feeRecipient).equals(PublicKey.default)) return 0n
  return (amount * BigInt(bps)) / 10000n
}

/** The relayer's quoted fee in a QUOTE mint (0 without a relayer or for a non-quote). */
export function relayerFee(params: SolanaParams, mint: string | PublicKey): bigint {
  const m = normalizeMint(mint).toBase58()
  const fee = params.relayer?.fee
  if (!fee) return 0n
  return BigInt(fee[m] ?? (m === NATIVE_MINT.toBase58() ? (fee.SOL ?? fee[SOL_ADDRESS.toBase58()]) : undefined) ?? 0)
}

/** Withdrawing `amount` (gross, ext_amount = -amount): what the recipient gets and what is spent. */
export function withdrawFees(params: SolanaParams, mint: string, amount: bigint) {
  const m = normalizeMint(mint).toBase58()
  const pf = protocolFee(params, amount, params.fees.withdrawFeeBps)
  const rf = relayerFee(params, m)
  const cut = protocolFee(params, rf, params.fees.withdrawFeeBps)
  // protocolFee / relayerFee: what each party receives; the user pays amount + rf.
  return { amount, received: amount - pf, protocolFee: { mint: m, amount: pf + cut }, relayerFee: { mint: m, amount: rf - cut }, spend: amount + rf }
}

/** The fee legs of a swap, exactly as swap.rs splits them. */
export function swapLegs(params: SolanaParams, mintIn: string | PublicKey, mintOut: string | PublicKey, amountIn: bigint) {
  const inQuote = isQuote(params, normalizeMint(mintIn))
  const feeIn = inQuote ? protocolFee(params, amountIn, params.fees.swapFeeBps) : 0n
  return {
    inQuote,
    feeIn,
    routeAmountIn: amountIn - feeIn,
    /** ExtData.fee: the relayer, in mint_in, when mint_in is a quote. */
    relayerFeeIn: inQuote ? relayerFee(params, mintIn) : 0n,
    /** SwapParams.relayer_fee_out: the relayer, from the proceeds, otherwise. */
    relayerFeeOut: inQuote ? 0n : relayerFee(params, mintOut),
  }
}

/** Net amount of the output note for a DEX output of `rawOut`. */
export function swapNetOut(params: SolanaParams, legs: ReturnType<typeof swapLegs>, rawOut: bigint): bigint {
  const feeOut = legs.inQuote ? 0n : protocolFee(params, rawOut, params.fees.swapFeeBps)
  return rawOut - feeOut - legs.relayerFeeOut
}

/** A SwapQuote from a route for `swapLegs(...).routeAmountIn` (backend quote or a local mock route). */
export function makeSwapQuote(
  params: SolanaParams,
  r: { mintIn: string; mintOut: string; amountIn: bigint; rawOut: bigint; routeData: string; remainingAccounts: { pubkey: string; isWritable: boolean }[]; swapProgramId: string; addressLookupTables?: string[] },
): SwapQuote {
  const legs = swapLegs(params, r.mintIn, r.mintOut, r.amountIn)
  const mIn = normalizeMint(r.mintIn).toBase58()
  const mOut = normalizeMint(r.mintOut).toBase58()
  const amountOut = swapNetOut(params, legs, r.rawOut)
  const cutIn = protocolFee(params, legs.relayerFeeIn, params.fees.swapFeeBps)
  return {
    amountIn: r.amountIn,
    routeAmountIn: legs.routeAmountIn,
    rawOut: r.rawOut,
    amountOut,
    minOut: amountOut,
    // What each party receives. Quote input: the protocol also cuts fee_on(ext.fee) from the relayer's leg.
    protocolFee: legs.inQuote ? { mint: mIn, amount: legs.feeIn + cutIn } : { mint: mOut, amount: r.rawOut - amountOut - legs.relayerFeeOut },
    relayerFee: legs.inQuote ? { mint: mIn, amount: legs.relayerFeeIn - cutIn } : { mint: mOut, amount: legs.relayerFeeOut },
    routeData: r.routeData,
    remainingAccounts: r.remainingAccounts,
    swapProgramId: r.swapProgramId,
    addressLookupTables: r.addressLookupTables,
  }
}

// ---------------------------------------------------------------- data source + context

export interface Leaf {
  /** Global index. */
  index: number | string
  commitment: string
  encryptedOutput: string
  /** Swap output leaves: SwapExecuted.amount_out. */
  amountOut?: string
}

/** Where leaves and spent flags come from: the backend by default. */
export interface SolanaSource {
  liveEpoch(mint: PublicKey): Promise<number>
  /** Every leaf of tree (mint, epoch) in local order, and its root when known. */
  leaves(mint: PublicKey, epoch: number): Promise<{ leaves: Leaf[]; root?: string }>
  /** Nullifiers as 64-char hex without 0x. */
  spent(nullifiers: string[]): Promise<boolean[]>
}

export const backendSource: SolanaSource = {
  async liveEpoch(mint) {
    return Number((await api(`/trees/${mint.toBase58()}/status`)).epoch ?? 0)
  },
  async leaves(mint, epoch) {
    // The chain (confirmed) can be ahead of the indexer (finalized, ~13 s behind). The root is
    // the chain's, so only a complete tree matches it: wait for the indexer to catch up.
    let status = await api(`/trees/${mint.toBase58()}/${epoch}/status`)
    for (let i = 0; i < 20 && status.indexed != null && status.indexed < status.nextIndex; i++) {
      await new Promise((r) => setTimeout(r, 2000))
      status = await api(`/trees/${mint.toBase58()}/${epoch}/status`)
    }
    if (status.indexed != null && status.indexed < status.nextIndex) throw new Error('Solana: the vault index is still syncing, try again in a few seconds')
    const leaves: Leaf[] = []
    while (leaves.length < status.nextIndex) {
      const page = await api(`/trees/${mint.toBase58()}/leaves?epoch=${epoch}&from=${leaves.length}&to=${status.nextIndex}`)
      if (!page.leaves?.length) throw new Error('Solana tree: leaves missing')
      leaves.push(...page.leaves)
    }
    return { leaves, root: status.root }
  },
  async spent(nullifiers) {
    return (await api('/nullifiers', { nullifiers })).spent
  },
}

/** Overrides for tests, scripts or a self-relaying client. Every field defaults to the backend. */
export interface SolanaContext {
  params?: SolanaParams
  source?: SolanaSource
  connection?: Connection
  /** Submits a relayed plan; default POST /solana/relay. */
  submit?: (plan: Plan) => Promise<string>
}

async function resolve(ctx: SolanaContext = {}) {
  const raw = ctx.params ?? (await getSolanaParams())
  const connection = () => ctx.connection ?? solanaConnection(raw)
  const params = await withTokenPrograms(raw, connection())
  return {
    params,
    source: ctx.source ?? backendSource,
    connection,
    submit: ctx.submit ?? relay,
  }
}

// ---------------------------------------------------------------- keys + scan

export async function deriveSolanaKeys(signMessage: (m: Uint8Array) => Promise<Uint8Array>): Promise<Keys> {
  // ed25519 is deterministic, so this is the same account on every device, like EVM.
  const sig = await signMessage(new TextEncoder().encode(SIGN_IN_MESSAGE))
  const { encryptionKey, keypair } = deriveKeys(ethers.utils.hexlify(sig))
  return { encryptionKey, keypair }
}

const normHex = (h: string) => toFixedHex(h.startsWith('0x') ? h : '0x' + h)

function buildTree(leaves: Leaf[]): MerkleTree {
  return new MerkleTree(
    MERKLE_TREE_HEIGHT,
    leaves.map((l) => BigNumber.from(normHex(l.commitment)).toString()),
    { hashFunction: poseidonHash2 as any, zeroElement: 0 },
  )
}

/** Recovers our note from a leaf, or null. Exported for tests. */
export async function openLeaf(l: Leaf, keys: Keys, field: BigNumber): Promise<Utxo | null> {
  const d = await decryptBlob(keys.encryptionKey, hexBytes(l.encryptedOutput))
  if (!d) return null
  const { epoch, local } = splitIndex(l.index)
  let u: Utxo
  if (d.kind === 'note') {
    u = new Utxo({ amount: d.amount, blinding: d.blinding, keypair: keys.keypair, assetId: field, index: local, epoch })
  } else {
    // Swap output: amount measured by the program, owner = the one-time key of its blinding.
    if (l.amountOut == null) return null
    const keypair = deriveTemporaryKeypair(keys.keypair.privkey, d.blinding)
    u = new Utxo({ amount: l.amountOut, blinding: d.blinding, keypair, assetId: field, index: local, epoch })
  }
  return u.amount.gt(0) && toFixedHex(u.getCommitment()) === normHex(l.commitment) ? u : null
}

async function loadTree(source: SolanaSource, mint: PublicKey, epoch: number) {
  const { leaves, root } = await source.leaves(mint, epoch)
  const tree = buildTree(leaves)
  if (root && toFixedHex(tree.root) !== normHex(root)) throw new Error('Solana tree: rebuilt root does not match')
  return { tree, leaves }
}

async function scan(source: SolanaSource, keys: Keys, mint: PublicKey) {
  const liveEpoch = await source.liveEpoch(mint)
  const field = mintField(mint)
  const trees = new Map<number, MerkleTree>()
  const mine: Utxo[] = []
  for (let e = 0; e <= liveEpoch; e++) {
    const { tree, leaves } = await loadTree(source, mint, e)
    trees.set(e, tree)
    mine.push(...(await Promise.all(leaves.map((l) => openLeaf(l, keys, field)))).filter((u): u is Utxo => !!u))
  }
  let notes: Utxo[] = []
  if (mine.length) {
    const spent = await source.spent(mine.map((u) => toFixedHex(u.getNullifier()).slice(2)))
    notes = mine.filter((_, i) => !spent[i])
  }
  return { trees, notes, liveEpoch }
}

export async function scanNotes(keys: Keys, mint: string, ctx?: SolanaContext): Promise<{ notes: SolanaNote[]; balance: bigint }> {
  const { source } = await resolve(ctx)
  const { notes } = await scan(source, keys, normalizeMint(mint))
  return { notes, balance: notes.reduce((s, n) => s + n.amount.toBigInt(), 0n) }
}

// ---------------------------------------------------------------- proving

async function proveTx(o: {
  tree: MerkleTree
  inputs: Utxo[]
  outputs: Utxo[]
  extAmount: bigint
  fee: bigint
  field: BigNumber
  hash: BigNumber
}): Promise<ProofBytes> {
  const { tree, inputs, outputs, extAmount, fee, field, hash } = o
  // utils.rs public_amount: ext - fee in the field.
  const publicAmount = BigNumber.from((extAmount - fee).toString()).add(FIELD_SIZE).mod(FIELD_SIZE)
  const input = {
    root: BigNumber.from(tree.root).toString(),
    inputNullifier: inputs.map((x) => x.getNullifier().toString()),
    outputCommitment: outputs.map((x) => x.getCommitment().toString()),
    publicAmount: publicAmount.toString(),
    extDataHash: hash.toString(),
    mintAddress: field.toString(),
    inAmount: inputs.map((x) => x.amount.toString()),
    inPrivateKey: inputs.map((x) => BigNumber.from(x.keypair.privkey).toString()),
    inBlinding: inputs.map((x) => x.blinding.toString()),
    inPathIndices: inputs.map((x) => (x.amount.gt(0) ? x.index! : 0)),
    inPathElements: inputs.map((x) =>
      x.amount.gt(0) ? tree.path(x.index!).pathElements.map(String) : new Array(MERKLE_TREE_HEIGHT).fill('0'),
    ),
    outAmount: outputs.map((x) => x.amount.toString()),
    outBlinding: outputs.map((x) => x.blinding.toString()),
    outPubkey: outputs.map((x) => x.keypair.pubkey.toString()),
  }
  const p = await prove(input, SOLANA.artifacts)
  return packProof(p, {
    root: BigNumber.from(tree.root),
    inputNullifiers: inputs.map((x) => x.getNullifier()),
    outputCommitments: outputs.map((x) => x.getCommitment()),
  })
}

const pad = (ins: Utxo[], field: BigNumber) => {
  const out = [...ins]
  while (out.length < 2) out.push(new Utxo({ assetId: field }))
  return out
}

/** Notes of ONE epoch covering `need`, and the change note back to us. */
function spendPlan(notes: Utxo[], need: bigint, liveEpoch: number, keys: Keys, field: BigNumber, mint: PublicKey) {
  let sel: ReturnType<typeof selectNotes>
  try {
    sel = selectNotes(notes, BigNumber.from(need.toString()), liveEpoch, { mergeSpare: true })
  } catch (e) {
    // Enough in total but no 2 notes of one epoch cover it: merge() consolidates that too.
    if (notes.reduce((s, n) => s + n.amount.toBigInt(), 0n) >= need) throw new SolanaMergeRequired(mint.toBase58())
    throw e
  }
  if (sel.needsMigration) throw new SolanaMergeRequired(mint.toBase58())
  const inputs = pad(sel.inputs, field)
  const inSum = inputs.reduce((s, n) => s + n.amount.toBigInt(), 0n)
  const outputs = [new Utxo({ amount: inSum - need, keypair: keys.keypair, assetId: field }), new Utxo({ assetId: field })]
  return { inputs, outputs, epoch: sel.epoch }
}

// ---------------------------------------------------------------- plans (relay body / instruction)

export type RelayKind = 'transact' | 'transact_spl' | 'execute_swap' | 'rotate_tree'

export interface Plan {
  kind: RelayKind
  args: Record<string, any>
  accounts: Record<string, string>
  remainingAccounts?: { pubkey: string; isWritable: boolean }[]
  addressLookupTables?: string[]
}

/** The exact POST /solana/relay body for a spend. Exported for the payload-shape test. */
export function relayPayload(
  kind: RelayKind,
  inEpoch: number,
  proof: ProofBytes,
  extAmount: bigint,
  fee: bigint,
  enc1: Uint8Array,
  enc2: Uint8Array,
  accounts: Record<string, PublicKey | null>,
  swap?: { params: SwapParams; remainingAccounts: { pubkey: string; isWritable: boolean }[]; addressLookupTables?: string[] },
): Plan {
  return {
    kind,
    args: {
      inEpoch,
      proof,
      extDataMinified: { extAmount: extAmount.toString(), fee: fee.toString() },
      encryptedOutput1: Array.from(enc1),
      encryptedOutput2: Array.from(enc2),
      ...(swap && {
        swapParams: {
          minOut: swap.params.minOut.toString(),
          deadline: swap.params.deadline.toString(),
          relayerFeeOut: swap.params.relayerFeeOut.toString(),
          outPubkey: Array.from(swap.params.outPubkey),
          outBlinding: Array.from(swap.params.outBlinding),
          encryptedOutput: Array.from(swap.params.encryptedOutput),
          routeData: Array.from(swap.params.routeData),
        },
      }),
    },
    accounts: Object.fromEntries(Object.entries(accounts).flatMap(([k, v]) => (v ? [[k, v.toBase58()]] : []))),
    ...(swap && { remainingAccounts: swap.remainingAccounts }),
    ...(swap?.addressLookupTables?.length && { addressLookupTables: swap.addressLookupTables }),
  }
}

/** A plan as the Anchor instruction, with `signer` as fee payer (the relayer, or the user). */
export async function planInstruction(plan: Plan, programId: string | PublicKey, signer: PublicKey): Promise<TransactionInstruction> {
  const program = new Program({ ...(idl as Idl), address: new PublicKey(programId).toBase58() }, {} as any)
  const accounts: Record<string, PublicKey | null> = Object.fromEntries(
    Object.entries(plan.accounts).map(([k, v]) => [k, new PublicKey(v)]),
  )
  accounts.signer = signer
  if (plan.kind === 'rotate_tree') return program.methods.rotateTree().accountsStrict(accounts as any).instruction()
  if (plan.kind === 'transact_spl') {
    accounts.signerTokenAccount ??= null
    accounts.recipientTokenAccount ??= null
  }
  const a = plan.args
  const bn = (s: string) => new BN(s)
  const args: any[] = [
    a.inEpoch,
    a.proof,
    { extAmount: bn(a.extDataMinified.extAmount), fee: bn(a.extDataMinified.fee) },
    Buffer.from(a.encryptedOutput1),
    Buffer.from(a.encryptedOutput2),
  ]
  if (plan.kind === 'execute_swap') {
    const s = a.swapParams
    args.push({
      minOut: bn(s.minOut), deadline: bn(s.deadline), relayerFeeOut: bn(s.relayerFeeOut),
      outPubkey: s.outPubkey, outBlinding: s.outBlinding,
      encryptedOutput: Buffer.from(s.encryptedOutput), routeData: Buffer.from(s.routeData),
    })
  }
  const remaining = (plan.remainingAccounts ?? []).map((r) => ({ pubkey: new PublicKey(r.pubkey), isSigner: false, isWritable: r.isWritable }))
  const m = (program.methods as any)[plan.kind === 'transact' ? 'transact' : plan.kind === 'transact_spl' ? 'transactSpl' : 'executeSwap']
  return m(...args).accountsStrict(accounts).remainingAccounts(remaining).instruction()
}

async function relay(plan: Plan): Promise<string> {
  return (await api('/relay', plan)).signature
}

/** Signs `ixs` with `wallet` as fee payer (v0 tx through the lookup tables) and confirms. */
export async function sendInstructions(
  conn: Connection,
  wallet: SolanaWallet,
  ixs: TransactionInstruction[],
  lookupTables: (string | null | undefined)[] = [],
  units = 1_400_000,
): Promise<string> {
  const alts: AddressLookupTableAccount[] = []
  for (const a of lookupTables) {
    if (!a) continue
    const alt = (await conn.getAddressLookupTable(new PublicKey(a))).value
    if (alt) alts.push(alt)
  }
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash()
  const msg = new TransactionMessage({
    payerKey: wallet.publicKey,
    recentBlockhash: blockhash,
    instructions: [
      ComputeBudgetProgram.setComputeUnitLimit({ units }),
      // A priority fee so a user-signed tx (deposit, self-submitted merge) lands under load.
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: USER_PRIORITY_MICROLAMPORTS }),
      ...ixs,
    ],
  }).compileToV0Message(alts)
  const signed = await wallet.signTransaction(new VersionedTransaction(msg))
  const signature = await conn.sendRawTransaction(signed.serialize())
  // Poll, as lib/ntt.ts does: the RPC is the backend's HTTP-only /solana-rpc proxy, so the
  // websocket confirmTransaction relies on would never deliver.
  for (;;) {
    const st = (await conn.getSignatureStatuses([signature])).value[0]
    if (st?.err) throw new Error(`Solana tx ${signature} failed: ${JSON.stringify(st.err)}`)
    if (st?.confirmationStatus === 'confirmed' || st?.confirmationStatus === 'finalized') return signature
    if ((await conn.getBlockHeight('confirmed')) > lastValidBlockHeight) throw new Error(`Solana transaction expired: ${signature}`)
    await new Promise((r) => setTimeout(r, 1000))
  }
}

/** 50k micro-lamports per CU: well under 0.0001 SOL for a deposit. */
const USER_PRIORITY_MICROLAMPORTS = 50_000
/** Deposit CU limit: ~300k measured on mainnet, plus headroom. The priority fee is price × limit. */
export const DEPOSIT_CU = 400_000
/** Nullifier PDA space (8-byte discriminator + 1); each transact creates two, rent paid by the signer. */
const NULLIFIER_SPACE = 9

/** Lamports a deposit costs the wallet on top of the amount: two nullifier rents, base fee, priority fee. */
/** A wallet must stay rent-exempt (0 data bytes: 890,880 lamports) or be emptied to exactly 0,
 *  which no estimate hits: Solana rejects a tx leaving it in between. Kept aside, not spent. */
export const WALLET_RENT_RESERVE = 890_880n

export async function depositNetworkCost(conn: Pick<Connection, 'getMinimumBalanceForRentExemption'>): Promise<bigint> {
  const rent = BigInt(await conn.getMinimumBalanceForRentExemption(NULLIFIER_SPACE))
  return 2n * rent + 5000n + BigInt(Math.ceil((USER_PRIORITY_MICROLAMPORTS * DEPOSIT_CU) / 1e6))
}

/** The wallet's PUBLIC balance per mint: SOL lamports, else the ATA under the mint's token program (0 when absent). */
export async function walletBalances(owner: PublicKey, ctx?: SolanaContext): Promise<Record<string, bigint>> {
  const r = await resolve(ctx)
  const conn = r.connection()
  const pd = pdas(r.params.programId)
  const out: Record<string, bigint> = {}
  await Promise.all(r.params.mints.map(async (m) => {
    const mint = normalizeMint(m.mint)
    if (isNative(mint)) return void (out[m.mint] = BigInt(await conn.getBalance(owner)))
    const info = await conn.getTokenAccountBalance(pd.ata(mint, owner, tokenProgramOf(r.params, mint))).catch(() => null)
    out[m.mint] = info ? BigInt(info.value.amount) : 0n
  }))
  return out
}

/** The wallet cannot cover amount (SOL only) + network cost. Lamports in `need` / `have`. */
export class SolanaInsufficientSol extends Error {
  constructor(readonly need: bigint, readonly have: bigint) {
    super(`Not enough SOL: need ${need} lamports, have ${have}`)
  }
}

/** The relayer's account for `mint` (wallet for SOL). */
function relayerAcct(params: SolanaParams, pd: ReturnType<typeof pdas>, mint: PublicKey, fallback?: PublicKey): PublicKey {
  const r = params.relayer?.address ? new PublicKey(params.relayer.address) : fallback
  if (!r) throw new SolanaApiError('Solana relayer not configured', 503)
  return pd.acct(mint, r, tokenProgramOf(params, mint))
}

/** transact / transact_spl plan. `recipient` is the wallet (SOL) or token account (SPL) bound by the hash. */
async function transactPlan(o: {
  params: SolanaParams
  keys: Keys
  mint: PublicKey
  tree: MerkleTree
  inEpoch: number
  liveEpoch: number
  inputs: Utxo[]
  outputs: Utxo[]
  extAmount: bigint
  fee: bigint
  feeRecipient: PublicKey
  recipient: PublicKey | null
  signerTokenAccount?: PublicKey
}): Promise<Plan> {
  const { params, keys, mint, extAmount, fee } = o
  const native = isNative(mint)
  const pd = pdas(params.programId)
  const tp = tokenProgramOf(params, mint)
  const field = mintField(mint)
  const [enc1, enc2] = await Promise.all(o.outputs.map((u) => encryptNote(keys.encryptionKey, u)))
  // SOL: the recipient wallet (any account when nothing is withdrawn); SPL: default when not withdrawing.
  const recipient = native ? (o.recipient ?? o.feeRecipient) : (o.recipient ?? PublicKey.default)
  const hash = extDataHash({ recipient, extAmount, encryptedOutput1: enc1, encryptedOutput2: enc2, fee, feeRecipient: o.feeRecipient, mintAddress: mint })
  const proof = await proveTx({ tree: o.tree, inputs: o.inputs, outputs: o.outputs, extAmount, fee, field, hash })
  const common = {
    globalConfig: pd.globalConfig, asset: pd.asset(mint), spendTree: pd.tree(mint, o.inEpoch), liveTree: pd.tree(mint, o.liveEpoch),
    ...pd.nullifiers(proof.inputNullifiers), feeRecipient: o.feeRecipient,
    protocolFeeAccount: pd.acct(mint, new PublicKey(params.fees.feeRecipient), tp), systemProgram: SystemProgram.programId,
    eventAuthority: pd.eventAuthority, program: new PublicKey(params.programId),
  }
  const accounts = native
    ? { ...common, solPool: pd.solPool, recipient }
    : {
        ...common, mint, pool: pd.pool(mint, tp), signerTokenAccount: o.signerTokenAccount ?? null,
        recipientTokenAccount: o.recipient, tokenProgram: tp, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      }
  return relayPayload(native ? 'transact' : 'transact_spl', o.inEpoch, proof, extAmount, fee, enc1, enc2, accounts)
}

// ---------------------------------------------------------------- actions

export async function deposit(p: { keys: Keys; wallet: SolanaWallet; mint: string; amount: bigint }, ctx?: SolanaContext): Promise<string> {
  const { keys, wallet, amount } = p
  const r = await resolve(ctx)
  const mint = normalizeMint(p.mint)
  if (!isQuote(r.params, mint)) throw new Error('Only quote assets can be deposited')
  const field = mintField(mint)
  const pd = pdas(r.params.programId)
  const user = wallet.publicKey
  const conn = r.connection()
  const need = (isNative(mint) ? amount : 0n) + (await depositNetworkCost(conn)) + WALLET_RENT_RESERVE
  const have = BigInt(await conn.getBalance(user))
  if (have < need) throw new SolanaInsufficientSol(need, have)
  const liveEpoch = await r.source.liveEpoch(mint)
  const { tree } = await loadTree(r.source, mint, liveEpoch)
  const plan = await transactPlan({
    params: r.params, keys, mint, tree, inEpoch: liveEpoch, liveEpoch,
    inputs: pad([], field),
    outputs: [new Utxo({ amount: amount.toString(), keypair: keys.keypair, assetId: field }), new Utxo({ assetId: field })],
    extAmount: amount, fee: 0n, feeRecipient: pd.acct(mint, user, tokenProgramOf(r.params, mint)), recipient: isNative(mint) ? user : null,
    signerTokenAccount: isNative(mint) ? undefined : pd.ata(mint, user, tokenProgramOf(r.params, mint)),
  })
  const ix = await planInstruction(plan, r.params.programId, user)
  return sendInstructions(conn, wallet, [ix], [r.params.altAddress], DEPOSIT_CU)
}

/** Withdraws `amount` (gross): `recipient` gets amount - protocol fee; notes also pay the relayer fee. See withdrawFees. */
export async function withdraw(p: { keys: Keys; mint: string; amount: bigint; recipient: string }, ctx?: SolanaContext): Promise<string> {
  const { keys, amount } = p
  const r = await resolve(ctx)
  const mint = normalizeMint(p.mint)
  if (!isQuote(r.params, mint)) throw new Error('Only quote assets can be withdrawn; swap this token into a quote first')
  const field = mintField(mint)
  const pd = pdas(r.params.programId)
  const to = new PublicKey(p.recipient)
  const fee = relayerFee(r.params, mint)
  const { trees, notes, liveEpoch } = await scan(r.source, keys, mint)
  const { inputs, outputs, epoch } = spendPlan(notes, amount + fee, liveEpoch, keys, field, mint)
  const plan = await transactPlan({
    params: r.params, keys, mint, tree: trees.get(epoch)!, inEpoch: epoch, liveEpoch, inputs, outputs,
    extAmount: -amount, fee, feeRecipient: relayerAcct(r.params, pd, mint),
    recipient: isNative(mint) ? to : pd.ata(mint, to, tokenProgramOf(r.params, mint)),
  })
  return r.submit(plan)
}

/**
 * Internal transfer (ext_amount 0) of the two notes that block a spend: the oldest epoch's
 * two largest (or the live epoch's two smallest when all are live), into one note in the
 * live epoch. Quotes are relayed and pay the relayer fee; non-quote tokens cannot pay a
 * fee, so they need `wallet` to sign and pay the transaction itself. Returns null when
 * there is nothing to merge.
 */
export async function merge(p: { keys: Keys; mint: string; wallet?: SolanaWallet }, ctx?: SolanaContext): Promise<string | null> {
  const r = await resolve(ctx)
  const mint = normalizeMint(p.mint)
  const field = mintField(mint)
  const pd = pdas(r.params.programId)
  const { trees, notes, liveEpoch } = await scan(r.source, p.keys, mint)
  const old = notes.filter((n) => n.epoch !== liveEpoch)
  const epoch = old.length ? Math.min(...old.map((n) => n.epoch)) : liveEpoch
  const pool = notes.filter((n) => n.epoch === epoch).sort((a, b) => (a.amount.lt(b.amount) ? -1 : 1))
  const picked = epoch === liveEpoch ? pool.slice(0, 2) : pool.slice(-2)
  if (picked.length < (epoch === liveEpoch ? 2 : 1)) return null
  const quote = isQuote(r.params, mint)
  const fee = quote && !p.wallet ? relayerFee(r.params, mint) : 0n
  const total = picked.reduce((s, n) => s + n.amount.toBigInt(), 0n)
  if (total <= fee) throw new Error('Notes too small to cover the relayer fee')
  const signer = p.wallet?.publicKey
  if (!quote && !signer) throw new Error('Merging a non-quote token needs a wallet to sign')
  const plan = await transactPlan({
    params: r.params, keys: p.keys, mint, tree: trees.get(epoch)!, inEpoch: epoch, liveEpoch,
    inputs: pad(picked, field),
    outputs: [new Utxo({ amount: (total - fee).toString(), keypair: p.keys.keypair, assetId: field }), new Utxo({ assetId: field })],
    extAmount: 0n, fee, feeRecipient: signer ? pd.acct(mint, signer, tokenProgramOf(r.params, mint)) : relayerAcct(r.params, pd, mint), recipient: null,
  })
  if (!p.wallet) return r.submit(plan)
  return sendInstructions(r.connection(), p.wallet, [await planInstruction(plan, r.params.programId, p.wallet.publicKey)], [r.params.altAddress])
}

export async function quoteSwap(p: { mintIn: string; mintOut: string; amountIn: bigint }, ctx?: SolanaContext): Promise<SwapQuote> {
  const { params } = await resolve(ctx)
  const mintIn = normalizeMint(p.mintIn).toBase58()
  const mintOut = normalizeMint(p.mintOut).toBase58()
  const q = await api(`/swap/quote?mintIn=${mintIn}&mintOut=${mintOut}&amountIn=${p.amountIn}`)
  const quote = makeSwapQuote(params, {
    mintIn, mintOut, amountIn: p.amountIn, rawOut: BigInt(q.rawOut), routeData: q.routeData,
    remainingAccounts: q.remainingAccounts, swapProgramId: q.swapProgramId, addressLookupTables: q.addressLookupTables,
  })
  if (BigInt(q.routeAmountIn) !== quote.routeAmountIn) throw new Error('Solana quote: route amount does not match the fee params')
  return quote
}

export async function swap(
  p: { keys: Keys; mintIn: string; mintOut: string; amountIn: bigint; quote: SwapQuote; slippageBps: number },
  ctx?: SolanaContext,
): Promise<string> {
  const { keys, amountIn, quote } = p
  const r = await resolve(ctx)
  const { params } = r
  const mintIn = normalizeMint(p.mintIn)
  const mintOut = normalizeMint(p.mintOut)
  if (mintIn.equals(mintOut)) throw new Error('Swap needs two different assets')
  const fieldIn = mintField(mintIn)
  const pd = pdas(params.programId)
  const swapProgram = new PublicKey(quote.swapProgramId)
  const legs = swapLegs(params, mintIn, mintOut, amountIn)
  if (legs.routeAmountIn !== quote.routeAmountIn) throw new Error('Swap quote is stale: fees changed')
  const { trees, notes, liveEpoch } = await scan(r.source, keys, mintIn)
  const { inputs, outputs, epoch } = spendPlan(notes, amountIn + legs.relayerFeeIn, liveEpoch, keys, fieldIn, mintIn)
  const [enc1, enc2] = await Promise.all(outputs.map((u) => encryptNote(keys.encryptionKey, u)))
  const [liveIn, liveOut] = [liveEpoch, await r.source.liveEpoch(mintOut)]

  // One-time output owner, exactly as the EVM swap: P is public in SwapParams.
  const outNote = new Utxo({ assetId: mintField(mintOut) })
  outNote.keypair = deriveTemporaryKeypair(keys.keypair.privkey, outNote.blinding)
  // min_out bounds the NET amount: apply the slippage to the DEX output, then the fees.
  const minOut = swapNetOut(params, legs, (quote.rawOut * BigInt(10000 - p.slippageBps)) / 10000n)
  if (minOut <= 0n) throw new Error('Swap too small to cover its fees')
  const swapParams: SwapParams = {
    minOut,
    deadline: BigInt(Math.floor(Date.now() / 1000) + 300),
    relayerFeeOut: legs.relayerFeeOut,
    outPubkey: Uint8Array.from(be32(outNote.keypair.pubkey)),
    outBlinding: Uint8Array.from(be32(outNote.blinding)),
    encryptedOutput: await encryptSwapOutput(keys.encryptionKey, outNote.blinding),
    routeData: Uint8Array.from(atob(quote.routeData), (c) => c.charCodeAt(0)),
  }
  const tpIn = tokenProgramOf(params, mintIn)
  const tpOut = tokenProgramOf(params, mintOut)
  const escrowIn = pd.ata(mintIn, pd.swapAuthority, tpIn)
  const relayerIn = relayerAcct(params, pd, mintIn)
  const relayerOut = relayerAcct(params, pd, mintOut)
  const extAmount = -amountIn
  const fee = legs.relayerFeeIn
  const hash = swapExtDataHash(
    { recipient: escrowIn, extAmount, encryptedOutput1: enc1, encryptedOutput2: enc2, fee, feeRecipient: relayerIn, mintAddress: mintIn },
    mintOut,
    swapProgram,
    relayerOut,
    swapParams,
  )
  const proof = await proveTx({ tree: trees.get(epoch)!, inputs, outputs, extAmount, fee, field: fieldIn, hash })
  const feeWallet = new PublicKey(params.fees.feeRecipient)
  const accounts = {
    globalConfig: pd.globalConfig, mintIn, mintOut, assetIn: pd.asset(mintIn), assetOut: pd.asset(mintOut),
    spendTree: pd.tree(mintIn, epoch), liveIn: pd.tree(mintIn, liveIn), liveOut: pd.tree(mintOut, liveOut),
    ...pd.nullifiers(proof.inputNullifiers), poolIn: pd.pool(mintIn, tpIn), poolOut: pd.pool(mintOut, tpOut),
    swapAuthority: pd.swapAuthority, escrowIn, escrowOut: pd.ata(mintOut, pd.swapAuthority, tpOut),
    swapEntry: pd.swapEntry(swapProgram), swapProgram, relayerIn, relayerOut,
    protocolIn: pd.acct(mintIn, feeWallet, tpIn), protocolOut: pd.acct(mintOut, feeWallet, tpOut),
    tokenProgramIn: tpIn, tokenProgramOut: tpOut, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
    eventAuthority: pd.eventAuthority, program: new PublicKey(params.programId),
  }
  return r.submit(
    relayPayload('execute_swap', epoch, proof, extAmount, fee, enc1, enc2, accounts, {
      params: swapParams,
      remainingAccounts: quote.remainingAccounts,
      addressLookupTables: [...(params.altAddress ? [params.altAddress] : []), ...(quote.addressLookupTables ?? [])],
    }),
  )
}

/** rotate_tree plan for `mint` (anyone once the live tree is full; the admin any time). */
export function rotateTreePlan(params: SolanaParams, mint: string, liveEpoch: number): Plan {
  const pd = pdas(params.programId)
  const m = normalizeMint(mint)
  const accounts = {
    globalConfig: pd.globalConfig, asset: pd.asset(m), liveTree: pd.tree(m, liveEpoch), nextTree: pd.tree(m, liveEpoch + 1),
    systemProgram: SystemProgram.programId, eventAuthority: pd.eventAuthority, program: new PublicKey(params.programId),
  }
  return { kind: 'rotate_tree', args: {}, accounts: Object.fromEntries(Object.entries(accounts).map(([k, v]) => [k, v.toBase58()])) }
}
