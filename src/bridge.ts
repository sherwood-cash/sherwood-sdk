// The Private Bridge — ZEC, SOL or BTC in, a shielded note out; and the same road back.
//
// A headless port of the web app's /zcash/* client (lib/zcash/api.ts + identity.ts) and of
// the two flows the bridge page runs on top of it:
//
//   IN   create a 'vault' order -> send the foreign coin to its deposit address -> the
//        bridge delivers to a ONE-TIME address on our chain that the server derived ->
//        once it has landed (status 'waiting_signature'), prove a deposit of exactly
//        `arrivedWei` HERE, from our own note keys, and hand the proof to the server,
//        which pays the gas out of that one-time address. The server funds a note it can
//        neither read nor spend, and the user's wallet never appears on chain at all.
//
//   OUT  create a withdraw order -> the server answers with `payTo`, an address on our
//        chain -> a relayed vault withdrawal pays it directly -> the bridge pays out on
//        the destination chain. One transaction, and the vault never learns a bridge is
//        involved.
//
// No accounts. An order is addressed by its unguessable token. The optional history hangs
// off a pseudonym derived one-way from the note encryption key, so the server can group an
// account's orders without ever learning which wallet they belong to.
import { ethers, BigNumber } from 'ethers'
import type { DerivedKeys } from './crypto/encryption.js'
import { assetIdOf, type Asset } from './config.js'

/** The foreign chain a bridge touches: a deposit's source, or an exit's destination. */
export type BridgeOrigin = 'zec' | 'sol' | 'btc'

/** What a bridged deposit becomes: shielded ETH, wZEC, or cbBTC (shown as wBTC). */
export type BridgeReceive = 'eth' | 'wzec' | 'cbbtc'

/** The token-shaped things /zcash/status publishes (wZEC, cbBTC), when switched on. */
export type BridgeTokenInfo =
  | { enabled: false }
  | { enabled: true; token: string; assetId: string; symbol: string; name: string; decimals: number }

export interface BridgeStatus {
  enabled: boolean
  /** Whether the swap leg is actually confidential, or only private at the two ends. */
  confidential: boolean
  /** Whether the server can receive on a one-time address and fund the deposit itself. */
  shieldedDelivery: boolean
  /** Whether a deposit finishes without the client online. */
  unattended: boolean
  confidentiality: 'public' | 'basic' | 'advanced'
  route: { bridge: string; lastMile: string | null; hopChainId: number | null; appChainId: number }
  notice: string
  wzec?: BridgeTokenInfo & { keeper?: string; backing?: string }
  cbbtc?: BridgeTokenInfo
  /** Chains a deposit may come from. Absent on an older server: ZEC and SOL. */
  origins?: BridgeOrigin[]
}

export interface BridgeQuote {
  amountIn: string
  /** Human units of what arrives. For wZEC, an ESTIMATE at Lighter's last price. */
  amountOut: string
  amountOutWei: string
  receive?: BridgeReceive
  usdgOut?: string
  markUsdg?: string
  amountInUsd: string | null
  amountOutUsd: string | null
  /** Seconds. */
  timeEstimate: number
}

export type BridgeOrderStatus =
  | 'awaiting_deposit'
  | 'processing'
  | 'bridging'
  /** The funds are on the one-time address and their amount is known: sign now. */
  | 'waiting_signature'
  /** wZEC deposit: the keeper is buying the long and minting. */
  | 'hedging'
  /** wZEC exit: the keeper is burning and closing the long. */
  | 'redeeming'
  | 'done'
  | 'refunded'
  | 'failed'
  | 'expired'

export interface BridgeOrder {
  token: string
  direction: 'deposit' | 'withdraw'
  /** Destined for the vault via a server-derived one-time address. */
  vault: boolean
  /** Exactly what landed on the one-time address — the figure a proof must commit to. */
  arrivedWei: string | null
  /** The vault deposit. Its presence is what 'done' means for a deposit. */
  vaultTx: string | null
  receive?: BridgeReceive
  wzec?: Record<string, string | null> | null
  status: BridgeOrderStatus
  nearStatus: string | null
  confidential: boolean
  /** Deposits: where to send the foreign coin. Include `depositMemo` when set. */
  depositAddress: string
  depositMemo: string | null
  /** Base units. Which decimals apply depends on the direction — prefer the formatted pair. */
  amountIn: string
  amountOut: string
  amountInFormatted: string
  amountOutFormatted: string
  recipient: string
  payoutTo?: string | null
  refundTo: string
  originTx: string | null
  destinationTx: string | null
  deadline: string | null
  detail: string | null
  createdAt: string
  updatedAt: string
  timeEstimate?: number
  /** Withdrawals only: the address on OUR chain the vault withdrawal must pay. */
  payTo?: string
}

export interface BridgeOrderFunds {
  address: string
  asset?: BridgeReceive
  assetId?: string | null
  balanceWei: string
  depositableWei: string
  gasReserveWei: string
  /** What the proof must be for: the server's recorded figure. */
  arrivedWei: string | null
}

export interface BridgeResumePoint {
  where: 'app_chain' | 'hop_chain' | 'nowhere'
  appChainWei: string
  hopChainWei: string
  action: 'sign' | 'rebridge' | 'wait' | 'done'
  address: string
  resumed?: boolean
  arrivedWei?: string | null
}

export class BridgeApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message)
  }
}

export const isFinalBridgeStatus = (s: BridgeOrderStatus): boolean =>
  s === 'done' || s === 'refunded' || s === 'failed' || s === 'expired'

/* ------------------------------------------------------------------ identity */

const IDENTITY_DOMAIN = 'sherwood.zcash.identity.v1'

/**
 * The bridge pseudonym: address(keccak256("sherwood.zcash.identity.v1" ‖ K)), K the note
 * encryption key. Byte-identical to the web app's, so an agent and a browser on the same
 * wallet share one bridge history.
 */
export function deriveBridgeIdentity(keys: Pick<DerivedKeys, 'encryptionKey'>): { accountId: string; signer: ethers.Wallet } {
  const identityKey = ethers.utils.keccak256(
    ethers.utils.concat([ethers.utils.toUtf8Bytes(IDENTITY_DOMAIN), keys.encryptionKey]),
  )
  const signer = new ethers.Wallet(identityKey)
  return { accountId: signer.address.toLowerCase(), signer }
}

/* ----------------------------------------------------------------------- api */

/** Thin HTTP client for /zcash/*. Stateless apart from a cached history session. */
export class BridgeApi {
  private readonly root: string
  private session: { accountId: string; token: string; expiresAt: number } | null = null

  constructor(apiUrl: string) {
    this.root = apiUrl.replace(/\/+$/, '') + '/zcash'
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
    const body = (await res.json().catch(() => null)) as any
    if (!res.ok) {
      throw new BridgeApiError(
        body?.reason || body?.error || `request failed (${res.status})`,
        body?.error || 'unknown',
        res.status,
      )
    }
    return body as T
  }

  status(): Promise<BridgeStatus> {
    return this.request('/status')
  }

  quote(amount: string, origin: BridgeOrigin = 'zec', receive: BridgeReceive = 'eth'): Promise<BridgeQuote> {
    return this.request(`/quote?amount=${encodeURIComponent(amount)}&origin=${origin}&receive=${receive}`)
  }

  createOrder(
    args: {
      amount: string
      origin?: BridgeOrigin
      refundTo: string
      mode: 'wallet' | 'vault'
      recipient?: string
      pointsAddress?: string
      receive?: BridgeReceive
    },
    headers: Record<string, string> = {},
  ): Promise<BridgeOrder> {
    return this.request('/order', { body: args, headers })
  }

  createWithdrawOrder(
    args: { amountWei: string; destination: string; refundAddress: string; origin?: BridgeOrigin; receive?: BridgeReceive },
    headers: Record<string, string> = {},
  ): Promise<BridgeOrder> {
    return this.request('/order/withdraw', { body: args, headers })
  }

  order(token: string): Promise<BridgeOrder> {
    return this.request(`/order/${encodeURIComponent(token)}`)
  }

  funds(token: string): Promise<BridgeOrderFunds> {
    return this.request(`/order/${encodeURIComponent(token)}/funds`)
  }

  shield(
    token: string,
    payload: { assetId: string; inEpoch: number; args: unknown; extData: unknown },
  ): Promise<{ txHash: string; amountWei: string; from: string }> {
    return this.request(`/order/${encodeURIComponent(token)}/shield`, { body: payload })
  }

  resumePoint(token: string): Promise<BridgeResumePoint> {
    return this.request(`/order/${encodeURIComponent(token)}/resume`)
  }

  resume(token: string): Promise<BridgeResumePoint> {
    return this.request(`/order/${encodeURIComponent(token)}/resume`, { method: 'POST' })
  }

  markSent(token: string, txHash: string): Promise<BridgeOrder> {
    return this.request(`/order/${encodeURIComponent(token)}/sent`, { body: { txHash } })
  }

  async volume24h(): Promise<number | null> {
    const r = await this.request<{ usd24h: number | null }>('/volume')
    return typeof r.usd24h === 'number' ? r.usd24h : null
  }

  /** Bearer for the pseudonym, signing in with the DERIVED key only when needed. */
  async ownerHeader(keys: DerivedKeys | undefined): Promise<Record<string, string>> {
    if (!keys) return {}
    const id = deriveBridgeIdentity(keys)
    const s = this.session
    // A minute of headroom: a token expiring mid-request is worse than one refreshed early.
    if (s && s.accountId === id.accountId && s.expiresAt > Date.now() + 60_000) {
      return { authorization: `Bearer ${s.token}` }
    }
    try {
      const { issuedAt, message } = await this.request<{ issuedAt: number; message: string }>(
        `/session/message?account=${id.accountId}`,
      )
      const signature = await id.signer.signMessage(message)
      const session = await this.request<{ token: string; expiresAt: number }>('/session', {
        body: { account: id.accountId, issuedAt, signature },
      })
      this.session = { accountId: id.accountId, token: session.token, expiresAt: session.expiresAt }
      return { authorization: `Bearer ${session.token}` }
    } catch {
      // The history is optional; losing it must never stop a bridge.
      return {}
    }
  }

  async claim(token: string, keys: DerivedKeys | undefined): Promise<boolean> {
    const headers = await this.ownerHeader(keys)
    if (!headers.authorization) return false
    await this.request(`/order/${encodeURIComponent(token)}/claim`, { method: 'POST', headers })
    return true
  }

  async history(keys: DerivedKeys | undefined): Promise<BridgeOrder[]> {
    const headers = await this.ownerHeader(keys)
    if (!headers.authorization) return []
    return (await this.request<{ orders: BridgeOrder[] }>('/orders', { headers })).orders
  }
}

/* -------------------------------------------------------------------- assets */

/**
 * The vault asset a bridge receive-mode lands in, built from /zcash/status so the token
 * addresses stay server-owned deployment state rather than something this package pins.
 * Null when that mode is not offered.
 */
export function bridgeAsset(status: BridgeStatus, receive: Exclude<BridgeReceive, 'eth'>): Asset | null {
  const info = receive === 'wzec' ? status.wzec : status.cbbtc
  if (!info || !info.enabled) return null
  const token = ethers.utils.getAddress(info.token)
  const assetId = assetIdOf(token)
  if (info.assetId && !BigNumber.from(info.assetId).eq(assetId)) {
    throw new Error(`bridge status: ${receive} assetId ${info.assetId} does not match its token ${token}`)
  }
  return { key: receive, symbol: info.symbol, token, decimals: info.decimals, native: false, assetId }
}
