// SherwoodClient — the high-level, headless entry point. Wraps the ZK privacy pool +
// shielded DEX so an agent or a dev can deposit, read their private balance, swap and
// withdraw with a single object. No user key ever leaves the process; withdrawals and
// swaps are relayed (the vault reimburses the relayer in-asset), deposits are self-signed.
import { ethers, BigNumber } from 'ethers'
import { Utxo } from './crypto/utxo.js'
import { Keypair, deriveSwapKeypair } from './crypto/keypair.js'
import { deriveKeys, signIn as deriveFromSigner, SIGN_IN_MESSAGE, type DerivedKeys } from './crypto/encryption.js'
import { prepareTransaction, hashSwapParams } from './transaction.js'
import { scanNotes, selectNotes, treeForEpoch, emptyTree, type OwnedNotes } from './tree.js'
import { SherwoodApi, feeForAsset, type RelaySwapParams } from './api.js'
import { resolveRoute, quoteAmountOut, type SwapRoute } from './swap.js'
import { VAULT_ABI, ERC20_ABI } from './abis.js'
import {
  DEPLOYMENT,
  DEFAULT_API_URL,
  isNativeAsset,
  isQuoteAsset,
  listAssets,
  findAsset,
  ZERO,
  type Asset,
} from './config.js'

export interface SherwoodClientOptions {
  /** Backend base URL. Defaults to https://api.sherwood.cash */
  apiUrl?: string
  /** JSON-RPC URL for chain reads (deposits + epoch/event lookups). Defaults to the bundled Alchemy endpoint. */
  rpcUrl?: string
  /** An EVM private key. A Wallet is created from it; required for deposits (which pay gas). */
  privateKey?: string
  /** An ethers Signer, if you'd rather supply your own (e.g. a hardware/remote signer). */
  signer?: ethers.Signer
  /** Circuit-artifact overrides (local paths / URLs). Defaults to the public Sherwood CDN. */
  artifacts?: { wasm?: string; zkey?: string; cacheDir?: string }
}

export type ProgressFn = (msg: string) => void

export interface Balance {
  asset: string
  symbol: string
  balance: string // human-readable total
  balanceRaw: string // base units
  /** Max amount spendable in ONE transaction (top-2 notes of the best epoch). Below the
   *  total when notes are fragmented — consolidate() to raise it. */
  spendable: string
  spendableRaw: string
  notes: number
  liveEpoch: number
}

export class SherwoodClient {
  readonly api: SherwoodApi
  readonly provider: ethers.providers.JsonRpcProvider
  signer?: ethers.Signer
  keys?: DerivedKeys
  private artifacts: SherwoodClientOptions['artifacts']

  constructor(opts: SherwoodClientOptions = {}) {
    this.api = new SherwoodApi(opts.apiUrl || DEFAULT_API_URL)
    this.provider = new ethers.providers.JsonRpcProvider(opts.rpcUrl || DEPLOYMENT.rpcUrl, {
      chainId: DEPLOYMENT.chainId,
      name: DEPLOYMENT.network,
    })
    this.artifacts = opts.artifacts
    if (opts.signer) this.signer = opts.signer.provider ? opts.signer : opts.signer.connect(this.provider)
    else if (opts.privateKey) this.signer = new ethers.Wallet(opts.privateKey, this.provider)
  }

  /** The connected wallet address, or null in read/derive-only mode. */
  async address(): Promise<string | null> {
    return this.signer ? this.signer.getAddress() : null
  }

  /**
   * Unlock the shielded account: sign SIGN_IN_MESSAGE with the wallet and derive the
   * spend/encryption keys. Deterministic per wallet. Pass a raw signature to derive
   * without a signer (e.g. one produced elsewhere).
   */
  async signIn(signature?: string): Promise<void> {
    if (signature) this.keys = deriveKeys(signature)
    else if (this.signer) this.keys = await deriveFromSigner(this.signer)
    else throw new Error('signIn needs a signer (privateKey/signer) or an explicit signature')
  }

  // Per-account serialization. A proof takes ~1s and the indexer lags by seconds, so two
  // concurrent actions would pick the SAME notes and one would revert (duplicate
  // nullifier). All spends run through this queue, so the same key never signs two
  // conflicting proofs at once.
  private queue: Promise<unknown> = Promise.resolve()
  private lock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn)
    this.queue = run.then(
      () => {},
      () => {},
    )
    return run
  }

  /**
   * Wait until the indexer has ingested a freshly-created note for `idOrKey`, i.e. its
   * leaf index is known. A note is UNSPENDABLE until then — the index feeds both the
   * nullifier and the Merkle path. Bounds the minimum agent cycle time; there is no HFT
   * here. Resolves when the asset's lastLeafIndex passes `minLeafIndex` (or times out).
   */
  async waitForIndexed(idOrKey: string, minLeafIndex: number, timeoutMs = 90_000, pollMs = 2500): Promise<void> {
    const asset = this.asset(idOrKey)
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      try {
        const s = await this.api.status(asset.assetId)
        if (typeof s.lastLeafIndex === 'number' && s.lastLeafIndex > minLeafIndex) return
      } catch {
        /* transient — retry */
      }
      await new Promise((r) => setTimeout(r, pollMs))
    }
  }

  private async lastLeafIndex(asset: Asset): Promise<number> {
    try {
      return (await this.api.status(asset.assetId)).lastLeafIndex
    } catch {
      return -1
    }
  }

  private requireKeys(): DerivedKeys {
    if (!this.keys) throw new Error('call signIn() first to unlock the shielded account')
    return this.keys
  }
  private requireSigner(): ethers.Signer {
    if (!this.signer) throw new Error('this action needs a signer (set privateKey or signer)')
    return this.signer
  }

  // ---- discovery ----
  listAssets(): Asset[] {
    return listAssets()
  }
  asset(idOrKey: string): Asset {
    const a = findAsset(idOrKey)
    if (!a) throw new Error(`unknown asset "${idOrKey}"`)
    return a
  }
  params() {
    return this.api.params()
  }
  relayInfo() {
    return this.api.relayInfo()
  }

  parseAmount(asset: Asset, amount: string | BigNumber): BigNumber {
    return BigNumber.isBigNumber(amount) ? amount : ethers.utils.parseUnits(amount, asset.decimals)
  }
  formatAmount(asset: Asset, raw: BigNumber): string {
    return ethers.utils.formatUnits(raw, asset.decimals)
  }

  // ---- balance ("scan your private notes") ----
  private async scan(asset: Asset): Promise<OwnedNotes> {
    const k = this.requireKeys()
    return scanNotes(asset.assetId, k.keypair, k.encryptionKey, this.api, this.provider)
  }

  async getBalance(idOrKey: string): Promise<Balance> {
    const asset = this.asset(idOrKey)
    const owned = await this.scan(asset)
    // Spendable in one tx = the best epoch's top-2 notes (the circuit spends ≤ 2 inputs
    // sharing one tree).
    const byEpoch = new Map<number, BigNumber[]>()
    for (const n of owned.notes) {
      const arr = byEpoch.get(n.epoch) ?? []
      arr.push(n.amount)
      byEpoch.set(n.epoch, arr)
    }
    let spendable = BigNumber.from(0)
    for (const arr of byEpoch.values()) {
      const top2 = arr.sort((a, b) => (b.gt(a) ? 1 : -1)).slice(0, 2).reduce((s, a) => s.add(a), BigNumber.from(0))
      if (top2.gt(spendable)) spendable = top2
    }
    return {
      asset: asset.key,
      symbol: asset.symbol,
      balance: this.formatAmount(asset, owned.balance),
      balanceRaw: owned.balance.toString(),
      spendable: this.formatAmount(asset, spendable),
      spendableRaw: spendable.toString(),
      notes: owned.notes.length,
      liveEpoch: owned.liveEpoch,
    }
  }

  async getBalances(): Promise<Balance[]> {
    const out: Balance[] = []
    for (const a of this.listAssets()) {
      try {
        out.push(await this.getBalance(a.key))
      } catch {
        /* skip assets with no live tree */
      }
    }
    return out
  }

  // ---- deposit (self-signed; pays gas) ----
  async deposit(idOrKey: string, amount: string | BigNumber, onProgress: ProgressFn = () => {}): Promise<string> {
    return this.lock(async () => {
      const asset = this.asset(idOrKey)
      const signer = this.requireSigner()
      const keys = this.requireKeys()
      const amt = this.parseAmount(asset, amount)
      const baseline = await this.lastLeafIndex(asset)

      // The deposit's output note lands in the live epoch; prove membership against its tree.
      const live = await this.scan(asset)
      const liveTree = treeForEpoch(live, live.liveEpoch)
      const out = new Utxo({ amount: amt, keypair: keys.keypair, assetId: asset.assetId })

      onProgress('Generating zero-knowledge proof…')
      const { args, extData } = await prepareTransaction({
        tree: liveTree.elements.length ? liveTree : emptyTree(),
        inputs: [],
        outputs: [out],
        encryptionKey: keys.encryptionKey,
        assetId: asset.assetId,
        artifacts: this.artifacts,
      })
      const inEpoch = live.liveEpoch
      const vault = new ethers.Contract(DEPLOYMENT.vault, VAULT_ABI, signer)

      if (!isNativeAsset(asset)) {
        const token = new ethers.Contract(asset.token, ERC20_ABI, signer)
        const owner = await signer.getAddress()
        const allowance: BigNumber = await token.allowance(owner, DEPLOYMENT.vault)
        if (allowance.lt(amt)) {
          onProgress('Approving token…')
          await (await token.approve(DEPLOYMENT.vault, amt)).wait()
        }
      }

      onProgress('Submitting deposit…')
      const tx = isNativeAsset(asset)
        ? await vault.transact(asset.assetId, inEpoch, args, extData, { value: amt })
        : await vault.transact(asset.assetId, inEpoch, args, extData)
      await tx.wait()
      // The new note is unspendable until the indexer knows its leaf index.
      onProgress('Waiting for the note to be indexed…')
      await this.waitForIndexed(asset.key, baseline)
      return tx.hash
    })
  }

  // ---- epoch consolidation (relayed; extAmount == 0) ----
  private async migrateOnce(asset: Asset, notes: OwnedNotes, sel: { epoch: number; inputs: Utxo[] }, onProgress: ProgressFn): Promise<string> {
    const keys = this.requireKeys()
    const info = await this.api.relayInfo()
    const fee = feeForAsset(info, asset.assetId)
    const inSum = sel.inputs.reduce((s, n) => s.add(n.amount), BigNumber.from(0))
    if (inSum.lte(fee)) throw new Error('These notes are too small to consolidate after the relayer fee')

    const merged = new Utxo({ amount: inSum.sub(fee), keypair: keys.keypair, assetId: asset.assetId })
    const { args, extData } = await prepareTransaction({
      tree: treeForEpoch(notes, sel.epoch),
      inputs: sel.inputs,
      outputs: [merged],
      fee,
      feeRecipient: info.relayer,
      encryptionKey: keys.encryptionKey,
      assetId: asset.assetId,
      artifacts: this.artifacts,
    })
    const baseline = await this.lastLeafIndex(asset)
    const { txHash } = await this.api.relayTransact({ assetId: asset.assetId.toString(), inEpoch: sel.epoch, proof: args, extData })
    await this.provider.waitForTransaction(txHash, 1)
    // The reissued note must be indexed before the next selection can pick it.
    await this.waitForIndexed(asset.key, baseline)
    return txHash
  }

  private static MAX_MIGRATIONS = 8

  // Consolidation loop (no lock — callable from within a locked withdraw/swap).
  private async _consolidate(asset: Asset, amount?: string | BigNumber, onProgress: ProgressFn = () => {}): Promise<string[]> {
    if (!isQuoteAsset(asset)) return [] // memecoins consolidate implicitly via a swap
    const info = await this.api.relayInfo()
    const fee = feeForAsset(info, asset.assetId)
    const hashes: string[] = []
    for (let step = 0; step < SherwoodClient.MAX_MIGRATIONS; step++) {
      const notes = await this.scan(asset)
      const target = amount ? this.parseAmount(asset, amount).add(fee) : notes.balance
      let sel
      try {
        sel = selectNotes(notes.notes, target, notes.liveEpoch)
      } catch {
        return hashes
      }
      if (!sel.needsMigration) return hashes
      onProgress(`Consolidating notes (step ${step + 1})…`)
      hashes.push(await this.migrateOnce(asset, notes, sel, onProgress))
    }
    throw new Error('Could not consolidate notes into a single transaction. Try a smaller amount.')
  }

  /** Consolidate notes until `amount` (or the whole balance) is spendable in one tx. */
  consolidate(idOrKey: string, amount?: string | BigNumber, onProgress: ProgressFn = () => {}): Promise<string[]> {
    return this.lock(() => this._consolidate(this.asset(idOrKey), amount, onProgress))
  }

  /** Alias matching the mission's naming: consolidate until `target` is spendable. */
  consolidateUntilSpendable(idOrKey: string, target: string | BigNumber, onProgress: ProgressFn = () => {}): Promise<string[]> {
    return this.consolidate(idOrKey, target, onProgress)
  }

  // ---- withdraw (relayed) ----
  async withdraw(idOrKey: string, amount: string | BigNumber, recipient: string, onProgress: ProgressFn = () => {}): Promise<string> {
    return this.lock(async () => {
      const asset = this.asset(idOrKey)
      if (!ethers.utils.isAddress(recipient)) throw new Error('recipient is not a valid address')
      const keys = this.requireKeys()
      const amt = this.parseAmount(asset, amount)

      await this._consolidate(asset, amount, onProgress)

      const info = await this.api.relayInfo()
      const fee = feeForAsset(info, asset.assetId)
      onProgress('Scanning your notes…')
      const notes = await this.scan(asset)
      const sel = selectNotes(notes.notes, amt.add(fee), notes.liveEpoch)
      if (sel.needsMigration) throw new Error('Balance is split across epochs; run consolidate() first')

      const inSum = sel.inputs.reduce((s, n) => s.add(n.amount), BigNumber.from(0))
      const change = new Utxo({ amount: inSum.sub(amt).sub(fee), keypair: keys.keypair, assetId: asset.assetId })
      const baseline = await this.lastLeafIndex(asset)

      onProgress('Generating zero-knowledge proof…')
      const { args, extData } = await prepareTransaction({
        tree: treeForEpoch(notes, sel.epoch),
        inputs: sel.inputs,
        outputs: [change],
        recipient,
        fee,
        feeRecipient: info.relayer,
        encryptionKey: keys.encryptionKey,
        assetId: asset.assetId,
        artifacts: this.artifacts,
      })
      onProgress('Relaying withdrawal…')
      const { txHash } = await this.api.relayTransact({ assetId: asset.assetId.toString(), inEpoch: sel.epoch, proof: args, extData })
      await this.waitForIndexed(asset.key, baseline)
      return txHash
    })
  }

  // ---- quote ----
  async quote(fromId: string, toId: string, amountIn: string | BigNumber): Promise<{ amountOut: string; amountOutRaw: string } | null> {
    const from = this.asset(fromId)
    const to = this.asset(toId)
    const inRaw = this.parseAmount(from, amountIn)
    const out = await quoteAmountOut(from, to, inRaw, this.provider)
    if (!out) return null
    return { amountOut: this.formatAmount(to, out), amountOutRaw: out.toString() }
  }

  // ---- swap (relayed private swap) ----
  async swap(p: {
    from: string
    to: string
    amountIn: string | BigNumber
    /** Explicit minimum output (base units / human string of `to`). */
    minOut?: string | BigNumber
    /** Or a slippage tolerance in % applied to the on-chain quote (default 1). */
    slippagePct?: number
    /** Optional pre-built route; otherwise the deepest pool is resolved automatically. */
    route?: SwapRoute
    deadlineSecs?: number
    onProgress?: ProgressFn
  }): Promise<{ txHash: string; amountOut: string; amountOutRaw: string }> {
    return this.lock(() => this._swap(p))
  }

  private async _swap(p: {
    from: string
    to: string
    amountIn: string | BigNumber
    minOut?: string | BigNumber
    slippagePct?: number
    route?: SwapRoute
    deadlineSecs?: number
    onProgress?: ProgressFn
  }): Promise<{ txHash: string; amountOut: string; amountOutRaw: string }> {
    const onProgress = p.onProgress ?? (() => {})
    const from = this.asset(p.from)
    const to = this.asset(p.to)
    const keys = this.requireKeys()
    const amountIn = this.parseAmount(from, p.amountIn)

    // Resolve minOut: explicit, else quote × (1 - slippage).
    let minOut: BigNumber
    if (p.minOut !== undefined) {
      minOut = this.parseAmount(to, p.minOut)
    } else {
      const quoted = await quoteAmountOut(from, to, amountIn, this.provider)
      if (!quoted) throw new Error(`could not price ${from.symbol} → ${to.symbol}; pass minOut explicitly`)
      const bps = Math.round((p.slippagePct ?? 1) * 100)
      minOut = quoted.mul(10_000 - bps).div(10_000)
    }

    const route = p.route ?? (await resolveRoute(from, to, this.provider, this.api))

    const info = await this.api.relayInfo()
    // The vault pays the relayer on whichever leg is a quote: on the input when selling a
    // quote, on the proceeds when selling a memecoin. Exactly one must be zero.
    const sellingAQuote = isQuoteAsset(from)
    const relayFee = feeForAsset(info, sellingAQuote ? from.assetId : to.assetId)
    const fee = sellingAQuote ? relayFee : BigNumber.from(0)
    const relayerFeeOut = sellingAQuote ? BigNumber.from(0) : relayFee

    onProgress('Scanning your notes…')
    if (sellingAQuote) await this._consolidate(from, this.formatAmount(from, amountIn), onProgress)
    const notes = await this.scan(from)
    const sel = selectNotes(notes.notes, amountIn.add(fee), notes.liveEpoch)
    if (sel.needsMigration) {
      const inThisEpoch = sel.inputs.reduce((s, n) => s.add(n.amount), BigNumber.from(0))
      throw new Error(
        `This amount is split across more than one batch of ${from.symbol} notes. Sell up to ${this.formatAmount(from, inThisEpoch)} ${from.symbol} now, then repeat.`,
      )
    }
    const inSum = sel.inputs.reduce((s, n) => s.add(n.amount), BigNumber.from(0))
    const change = new Utxo({ amount: inSum.sub(amountIn).sub(fee), keypair: keys.keypair, assetId: from.assetId })

    // SwapParams must be fully decided BEFORE proving; the proof commits to their hash.
    // P is a ONE-TIME key (plaintext calldata) derived from the wallet key + this note's
    // blinding, so swaps stay unlinkable yet recoverable.
    const outBlinding = new Utxo({ assetId: to.assetId }).blinding
    const outKeypair = deriveSwapKeypair(keys.keypair.privkey, outBlinding)
    const deadline = Math.floor(Date.now() / 1000) + (p.deadlineSecs ?? 1200)

    const swapParams: RelaySwapParams = {
      assetIn: from.assetId.toString(),
      tokenOut: isNativeAsset(to) ? ZERO : to.token,
      version: route.version as unknown as number,
      routeData: route.routeData,
      minOut: minOut.toString(),
      deadline,
      outPubkey: ethers.utils.hexZeroPad(outKeypair.pubkey.toHexString(), 32),
      outBlinding: ethers.utils.hexZeroPad(BigNumber.from(outBlinding).toHexString(), 32),
      relayerFeeOut: relayerFeeOut.toString(),
      encryptedOutput: await new Utxo({ amount: 0, keypair: outKeypair, blinding: outBlinding, assetId: to.assetId }).encrypt(keys.encryptionKey),
    }

    onProgress('Generating zero-knowledge proof…')
    const { args: proofArgs, extData } = await prepareTransaction({
      tree: treeForEpoch(notes, sel.epoch),
      inputs: sel.inputs,
      outputs: [change],
      recipient: DEPLOYMENT.vault,
      fee,
      feeRecipient: info.relayer,
      encryptionKey: keys.encryptionKey,
      assetId: from.assetId,
      swapParamsHash: hashSwapParams(swapParams),
      artifacts: this.artifacts,
    })

    const toBaseline = await this.lastLeafIndex(to)
    onProgress('Relaying swap…')
    const { txHash } = await this.api.relaySwap({ inEpoch: sel.epoch, proof: proofArgs, extData, params: swapParams })
    const receipt = await this.provider.waitForTransaction(txHash, 1)
    const amountOut = this.parseSwapReceipt(receipt, to.assetId)
    // The output note (in `to`) is unspendable until the indexer pins its leaf + amount.
    await this.waitForIndexed(to.key, toBaseline)
    return { txHash, amountOut: this.formatAmount(to, amountOut), amountOutRaw: amountOut.toString() }
  }

  // Read amountOut (Y) from a swap receipt's Swap event.
  private parseSwapReceipt(receipt: ethers.providers.TransactionReceipt, assetOut: BigNumber): BigNumber {
    const iface = new ethers.utils.Interface(VAULT_ABI)
    for (const log of receipt.logs) {
      try {
        const parsed = iface.parseLog(log)
        if (parsed.name === 'Swap' && (parsed.args.assetOut as BigNumber).eq(assetOut)) {
          return parsed.args.amountOut as BigNumber
        }
      } catch {
        /* not a vault log */
      }
    }
    throw new Error('Swap event not found in receipt — cannot recover output amount')
  }
}
