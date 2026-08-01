// Client for the Sherwood backend (indexer + relayer + proxies) at api.sherwood.cash.
// The backend holds no user keys; it serves the Merkle-tree leaves and the spent set,
// relays signed proofs, and proxies Uniswap routing / bridge quotes.
import { BigNumber } from 'ethers'
import { MERKLE_TREE_HEIGHT } from './crypto/utils.js'

export interface CommitmentLeaf {
  commitment: string
  index: number // GLOBAL leaf index as emitted by the vault
  encryptedOutput: string
  swapAmount?: string | null
}

export interface RelayProof {
  pA: [string, string]
  pB: [[string, string], [string, string]]
  pC: [string, string]
  root: string
  inputNullifiers: [string, string]
  outputCommitments: [string, string]
  publicAmount: string
  extDataHash: string
}

export interface RelayExtData {
  recipient: string
  extAmount: string
  feeRecipient: string
  fee: string
  encryptedOutput1: string
  encryptedOutput2: string
  swapParamsHash: string
}

export interface RelaySwapParams {
  assetIn: string
  tokenOut: string
  version: number // 0=V2, 1=V3, 2=V4
  routeData: string
  minOut: string
  deadline: number
  outPubkey: string
  outBlinding: string
  relayerFeeOut: string
  encryptedOutput: string
}

export interface RelayInfo {
  relayer: string
  vault: string
  chainId: number
  minFee?: string
  // Per-asset relayer fee, keyed by assetId (decimal string). Shape varies; handled by
  // feeForAsset.
  fees?: Record<string, string> | { assetId: string; fee: string }[]
}

const PAGE = 10000 // backend clamps /utxos `limit` to 10 000

export class SherwoodApi {
  constructor(public readonly baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, '')
  }

  private async get(path: string): Promise<any> {
    const res = await fetch(`${this.baseUrl}${path}`, { headers: { accept: 'application/json' } })
    if (!res.ok) throw new Error(`GET ${path} → ${res.status} ${res.statusText}`)
    return res.json()
  }

  private async post(path: string, body: unknown): Promise<any> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`POST ${path} → ${res.status} ${res.statusText} ${text}`.trim())
    }
    return res.json()
  }

  // ---- read: tree geometry & assets ----
  params(): Promise<any> {
    return this.get('/params')
  }

  assets(): Promise<any> {
    return this.get('/assets')
  }

  status(assetId: BigNumber | string): Promise<{ lastLeafIndex: number; commitmentCount?: number; settledIndex?: number }> {
    return this.get(`/assets/${assetId.toString()}/status`)
  }

  firstDeposit(address: string): Promise<any> {
    return this.get(`/first-deposit/${address}`)
  }

  tokens(): Promise<any> {
    return this.get('/tokens')
  }

  token(address: string): Promise<any> {
    return this.get(`/tokens/${address}`)
  }

  // Verify the indexer's tree geometry matches the circuit; a mismatch silently produces
  // unspendable notes, so we refuse rather than scan.
  async assertParams(): Promise<void> {
    const p = await this.params()
    if (p.merkleTreeHeight !== undefined && Number(p.merkleTreeHeight) !== MERKLE_TREE_HEIGHT) {
      throw new Error(`indexer merkleTreeHeight=${p.merkleTreeHeight} but the circuit uses ${MERKLE_TREE_HEIGHT}`)
    }
    const expected = 2 ** MERKLE_TREE_HEIGHT
    if (p.treeCapacity !== undefined && Number(p.treeCapacity) !== expected) {
      throw new Error(`indexer treeCapacity=${p.treeCapacity} but the circuit uses ${expected}`)
    }
  }

  // Every commitment for one asset, ordered by global leaf index. Paging is a cursor on
  // the global index (indices jump a full tree capacity at each epoch rotation).
  async commitments(assetId: BigNumber | string): Promise<CommitmentLeaf[]> {
    const id = assetId.toString()
    const status = await this.status(id)
    const last = status.lastLeafIndex
    const out: CommitmentLeaf[] = []
    if (last < 0) return out
    let fromIndex = 0
    while (fromIndex <= last) {
      const data = await this.get(`/assets/${id}/utxos?fromIndex=${fromIndex}&limit=${PAGE}`)
      const page = (data.utxos ?? []) as CommitmentLeaf[]
      if (!page.length) break
      for (const u of page) {
        out.push({
          commitment: u.commitment,
          index: u.index,
          encryptedOutput: u.encryptedOutput,
          swapAmount: u.swapAmount ?? null,
        })
      }
      const highest = page[page.length - 1].index
      if (!(highest >= fromIndex)) break
      fromIndex = highest + 1
    }
    out.sort((a, b) => a.index - b.index)
    return out
  }

  // The spent-nullifier set, lowercased. Nullifiers are GLOBAL (no assetId); membership
  // alone decides spentness.
  async nullifiers(): Promise<Set<string>> {
    const data = await this.get('/nullifiers')
    return new Set((data.nullifiers as string[]).map((n) => n.toLowerCase()))
  }

  isNullifierSpent(nullifier: string): Promise<{ spent: boolean }> {
    return this.get(`/nullifiers/${nullifier}`)
  }

  // ---- relayer ----
  relayInfo(): Promise<RelayInfo> {
    return this.get('/relay/info')
  }

  // POST /relay/transact — alias /relay/withdraw. Deposits/withdrawals/consolidations.
  relayTransact(body: { assetId: string; inEpoch: number; proof: RelayProof; extData: RelayExtData }): Promise<{ txHash: string }> {
    return this.post('/relay/transact', body)
  }

  relaySwap(body: { inEpoch: number; proof: RelayProof; extData: RelayExtData; params: RelaySwapParams }): Promise<{ txHash: string }> {
    return this.post('/relay/swap', body)
  }

  // ---- routing / bridge proxies ----
  bestPool(query: { tokenA: string; tokenB: string; amountIn?: string }): Promise<any> {
    const qs = new URLSearchParams(query as Record<string, string>).toString()
    return this.get(`/best-pool?${qs}`)
  }

  topTokens(): Promise<any> {
    return this.get('/top-tokens')
  }

  bridgePrice(body: unknown): Promise<any> {
    return this.post('/bridge/price', body)
  }

  bridgeQuote(body: unknown): Promise<any> {
    return this.post('/bridge/quote', body)
  }

  bridgeStatus(requestId: string): Promise<any> {
    return this.get(`/bridge/intents/status?requestId=${encodeURIComponent(requestId)}`)
  }
}

// The relayer fee for one asset, from /relay/info. Tolerates both the map and array
// shapes and falls back to minFee.
export function feeForAsset(info: RelayInfo, assetId: BigNumber | string): BigNumber {
  const id = assetId.toString()
  const fees = info.fees
  if (fees) {
    if (Array.isArray(fees)) {
      const hit = fees.find((f) => f.assetId === id)
      if (hit) return BigNumber.from(hit.fee)
    } else if (fees[id] !== undefined) {
      return BigNumber.from(fees[id])
    }
  }
  return BigNumber.from(info.minFee ?? 0)
}
