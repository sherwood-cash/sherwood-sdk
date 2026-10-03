// P2P cash-out — a private vault exit that ends as fiat (Venmo, Revolut, Wise…) through Peer
// (peer.xyz). A headless port of the web app's bank cash-out (lib/cashout.ts + cashoutApi.ts):
//
//   1. createOrder(): the server opens an order with a ONE-TIME address (`payTo`) on our chain.
//      A relayed vault withdrawal pays it; the server forwards it through Relay, which delivers
//      Base USDC (plus a little Base ETH for gas) to a fresh CASH-OUT ADDRESS derived below.
//   2. Once 'delivered', the cash-out address lists that USDC in Peer escrow with a payee handle.
//      A buyer pays the handle in fiat, proves it, and the escrow releases the USDC to them.
//
// The cash-out key is derived from the shielded root key and never leaves this process.
import { ethers } from 'ethers'
import { createWalletClient, http, type WalletClient } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { base } from 'viem/chains'
import type { CashClient, CashReceiveLeg, CurrencyType } from '@zkp2p/cash'

export const BASE_USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
export const P2P_NATIVE = '0x0000000000000000000000000000000000000000'

export type P2PStatus = 'awaiting_funds' | 'forwarding' | 'bridging' | 'delivered' | 'listed' | 'refunded' | 'failed'

export interface P2POrder {
  token: string
  status: P2PStatus
  refundBy: 'relay' | 'user' | null
  refundable: boolean
  currency: string
  symbol: string
  decimals: number
  amountIn: string
  /** The one-time address the vault withdrawal pays. */
  payTo: string
  /** The Base cash-out address (Peer maker) and its derivation index. */
  recipient: string
  slot: number
  refundTo: string
  platform: string
  handle: string
  fiat: string
  vaultTx: string | null
  forwardTx: string | null
  relayRequestId: string | null
  relayStatus: string | null
  usdcOut: string | null
  destinationTx: string | null
  refundTx: string | null
  peerDepositId: string | null
  detail: string | null
  createdAt: string
  updatedAt: string
}

export const isFinalP2PStatus = (s: P2PStatus): boolean => s === 'listed' || s === 'refunded' || s === 'failed'

export class P2PApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message)
  }
}

/** Client for the backend's /cashout/* routes. */
export class P2PApi {
  private readonly root: string

  constructor(apiUrl: string) {
    this.root = apiUrl.replace(/\/+$/, '') + '/cashout'
  }

  async request<T>(path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<T> {
    const res = await fetch(`${this.root}${path}`, {
      method: init.method ?? (init.body !== undefined ? 'POST' : 'GET'),
      headers: {
        accept: 'application/json',
        ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(init.headers ?? {}),
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    })
    const body: any = await res.json().catch(() => null)
    if (!res.ok) throw new P2PApiError(body?.reason || body?.error || `request failed (${res.status})`, body?.error || 'unknown', res.status)
    return body as T
  }

  status = (): Promise<{ enabled: boolean; tokens: boolean }> => this.request('/status')
  fillStats = (): Promise<{ stats: Record<string, { fills: number; medianFillSeconds?: number }>; updatedAt: number | null }> =>
    this.request('/fill-stats')
  quote = async (currency: string, amount: bigint): Promise<{ usdcOut: bigint; eta: number }> => {
    const q = await this.request<{ usdcOut: string; eta: number }>(`/quote?${new URLSearchParams({ currency, amount: amount.toString() })}`)
    return { usdcOut: BigInt(q.usdcOut), eta: q.eta }
  }
  createOrder = (
    body: { currency: string; symbol: string; decimals: number; amount: string; recipient: string; slot: number; refundTo: string; platform: string; handle: string; fiat: string },
    headers: Record<string, string>,
  ): Promise<P2POrder> => this.request('/order', { body, headers })
  order = (token: string): Promise<P2POrder> => this.request(`/order/${encodeURIComponent(token)}`)
  markSent = (token: string, txHash: string): Promise<P2POrder> => this.request(`/order/${encodeURIComponent(token)}/sent`, { body: { txHash } })
  markListed = (token: string, depositId: string): Promise<P2POrder> =>
    this.request(`/order/${encodeURIComponent(token)}/listed`, { body: { depositId } })
  refund = (token: string): Promise<P2POrder> => this.request(`/order/${encodeURIComponent(token)}/refund`, { method: 'POST' })
  claim = (token: string, headers: Record<string, string>): Promise<{ claimed: boolean }> =>
    this.request(`/order/${encodeURIComponent(token)}/claim`, { method: 'POST', headers })
  history = async (headers: Record<string, string>): Promise<P2POrder[]> =>
    headers.authorization ? (await this.request<{ orders: P2POrder[] }>('/orders', { headers })).orders : []
}

/* ---------------- Peer ---------------- */

let cash: Promise<CashClient> | null = null
/** Loaded on first use, so the pool works without Peer's deps being touched. */
export function peerCash(): Promise<CashClient> {
  cash ??= import('@zkp2p/cash')
    .then((m) => m.createCashClient({ environment: 'production' }))
    .catch((e) => {
      cash = null
      throw e
    })
  return cash
}

/** Rails that list every currency they support on one order (faster matching). */
const MULTI_CURRENCY = new Set(['revolut'])

export function receiveLeg(platform: string, currency: string, payee: string, railCurrencies: string[] = [currency]): CashReceiveLeg {
  if (MULTI_CURRENCY.has(platform) && railCurrencies.length > 1) {
    const all = [...railCurrencies].sort() as CurrencyType[]
    return { platform, currencies: all as [CurrencyType, ...CurrencyType[]], payee }
  }
  return { platform, currency: currency as CurrencyType, payee }
}

/* ---------------- cash-out addresses ---------------- */
// Must match the web app (lib/cashout.ts) byte for byte: the same wallet finds the same
// addresses, and so the same Peer orders, from either side. NEVER change the domain.
const CASHOUT_DOMAIN = 'sherwood.cashout.v1'
const GAP = 3

export const baseRead = new ethers.providers.StaticJsonRpcProvider(base.rpcUrls.default.http[0], base.id)

export function cashoutPrivateKey(rootPrivkey: string, index: number): string {
  return ethers.utils.keccak256(ethers.utils.defaultAbiCoder.encode(['uint256', 'string', 'uint256'], [rootPrivkey, CASHOUT_DOMAIN, index]))
}

export const cashoutAddress = (rootPrivkey: string, index: number): string => ethers.utils.computeAddress(cashoutPrivateKey(rootPrivkey, index))

export function cashoutSigner(rootPrivkey: string, index: number): WalletClient {
  return createWalletClient({
    account: privateKeyToAccount(cashoutPrivateKey(rootPrivkey, index) as `0x${string}`),
    chain: base,
    transport: http(),
  })
}

export async function baseUsdcBalance(owner: string): Promise<bigint> {
  const c = new ethers.Contract(BASE_USDC, ['function balanceOf(address) view returns (uint256)'], baseRead)
  return BigInt((await c.balanceOf(owner)).toString())
}

export interface CashoutSlot {
  index: number
  address: string
  /** Base USDC sitting on the address, i.e. not (or no longer) in a Peer order. */
  usdc: bigint
}

/** Every cash-out address used so far, and the first free index not in `reserved`. */
export async function scanCashoutSlots(rootPrivkey: string, reserved: number[] = []): Promise<{ used: CashoutSlot[]; next: number }> {
  const used: CashoutSlot[] = []
  let next = -1
  for (let i = 0, empty = 0; empty < GAP; i++) {
    const address = cashoutAddress(rootPrivkey, i)
    const [nonce, usdc] = await Promise.all([baseRead.getTransactionCount(address), baseUsdcBalance(address)])
    if (nonce > 0 || usdc > 0n) {
      used.push({ index: i, address, usdc })
      empty = 0
    } else {
      if (next < 0 && !reserved.includes(i)) next = i
      empty++
    }
  }
  return { used, next }
}
