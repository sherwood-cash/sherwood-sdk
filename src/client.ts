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
  BridgeApi,
  bridgeAsset,
  isFinalBridgeStatus,
  type BridgeOrder,
  type BridgeOrigin,
  type BridgeQuote,
  type BridgeReceive,
  type BridgeResumePoint,
  type BridgeStatus,
} from './bridge.js'
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
  /** The Private Bridge endpoints (/zcash/*). The bridge* methods below drive them. */
  readonly bridgeApi: BridgeApi
  readonly provider: ethers.providers.JsonRpcProvider
  signer?: ethers.Signer
  keys?: DerivedKeys
  private artifacts: SherwoodClientOptions['artifacts']

  constructor(opts: SherwoodClientOptions = {}) {
    this.api = new SherwoodApi(opts.apiUrl || DEFAULT_API_URL)
    this.bridgeApi = new BridgeApi(opts.apiUrl || DEFAULT_API_URL)
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
    const q = idOrKey.toLowerCase()
    const a =
      findAsset(idOrKey) ??
      [...this.extraAssets.values()].find(
        (x) => x.key.toLowerCase() === q || x.symbol.toLowerCase() === q || x.token.toLowerCase() === q,
      )
    if (!a) throw new Error(`unknown asset "${idOrKey}"`)
    return a
  }

  // Assets learned at runtime rather than bundled — the bridge's wZEC and cbBTC, whose
  // addresses /zcash/status publishes. Consulted after the bundled list.
  private readonly extraAssets = new Map<string, Asset>()

  /** Make an asset the bundled deployment does not list usable by every method here. */
  addAsset(asset: Asset): void {
    if (findAsset(asset.token)) return
    this.extraAssets.set(asset.token.toLowerCase(), asset)
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
    for (const a of [...this.listAssets(), ...this.extraAssets.values()]) {
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
      this.requireKeys()
      const amt = this.parseAmount(asset, amount)
      const baseline = await this.lastLeafIndex(asset)
      const { args, extData, inEpoch } = await this.buildDepositProof(asset, amt, onProgress)
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

  /**
   * A deposit proof for `amount` of `asset` into our own notes, not yet submitted.
   *
   * A deposit spends nothing, so its root is only checked against the LIVE epoch's tree —
   * where the output note lands — and the epoch travels with the proof, because the vault
   * checks the root against treeIdOf(assetId, inEpoch) even for a deposit.
   */
  private async buildDepositProof(asset: Asset, amount: BigNumber, onProgress: ProgressFn) {
    const keys = this.requireKeys()
    const live = await this.scan(asset)
    const liveTree = treeForEpoch(live, live.liveEpoch)
    const out = new Utxo({ amount, keypair: keys.keypair, assetId: asset.assetId })
    onProgress('Generating zero-knowledge proof…')
    const { args, extData } = await prepareTransaction({
      tree: liveTree.elements.length ? liveTree : emptyTree(),
      inputs: [],
      outputs: [out],
      encryptionKey: keys.encryptionKey,
      assetId: asset.assetId,
      artifacts: this.artifacts,
    })
    return { args, extData, inEpoch: live.liveEpoch }
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

  // ---- Private Bridge (/zcash/*): ZEC / SOL / BTC in and out of the pool ----
  //
  // IN:  bridgeDeposit() -> send the coin to order.depositAddress -> bridgeComplete()
  //      (or bridgeShield() once the order reads 'waiting_signature').
  // OUT: bridgeWithdraw() — one relayed withdrawal paying the order's `payTo`.

  private bridgeStatusCache: { at: number; status: BridgeStatus } | null = null

  /**
   * What the bridge offers right now: origins, receive modes, confidentiality. Also
   * registers the wZEC / cbBTC assets it publishes, so balance/swap/withdraw accept them.
   * Cached for five minutes; pass `fresh` to refetch.
   */
  async bridgeStatus(fresh = false): Promise<BridgeStatus> {
    const hit = this.bridgeStatusCache
    if (!fresh && hit && Date.now() - hit.at < 5 * 60_000) return hit.status
    const status = await this.bridgeApi.status()
    for (const r of ['wzec', 'cbbtc'] as const) {
      const a = bridgeAsset(status, r)
      if (a) this.addAsset(a)
    }
    this.bridgeStatusCache = { at: Date.now(), status }
    return status
  }

  /** What `amount` of the origin coin becomes, before fees move. Human units in. */
  bridgeQuote(p: { amount: string; from?: BridgeOrigin; receive?: BridgeReceive }): Promise<BridgeQuote> {
    return this.bridgeApi.quote(p.amount, p.from ?? 'zec', p.receive ?? 'eth')
  }

  /** The receive modes a deposit from `from` may pick, first the default. Mirrors the app. */
  async bridgeReceiveOptions(from: BridgeOrigin): Promise<BridgeReceive[]> {
    const status = await this.bridgeStatus()
    if (from === 'btc') return status.cbbtc?.enabled ? ['cbbtc', 'eth'] : ['eth']
    return status.wzec?.enabled ? ['eth', 'wzec'] : ['eth']
  }

  /**
   * Open a bridge deposit into the pool.
   *
   * Always a 'vault' order: the bridge pays a one-time address the server derives, and
   * that address funds a shielded deposit for whoever proves it — so this wallet never
   * appears on chain. Send `amount` of the origin coin to `order.depositAddress` (with
   * `order.depositMemo` when set), then call bridgeComplete(order.token).
   *
   * `refundTo` is an address on the ORIGIN chain (a ZEC t-address, a Solana pubkey, a BTC
   * address): the only place a failed bridge can pay back. `pointsAddress` defaults to the
   * connected wallet, as in the app; pass null to credit no one.
   */
  async bridgeDeposit(p: {
    amount: string
    from?: BridgeOrigin
    refundTo: string
    receive?: BridgeReceive
    pointsAddress?: string | null
  }): Promise<BridgeOrder> {
    const from = p.from ?? 'zec'
    const status = await this.bridgeStatus()
    if (!status.enabled) throw new Error('the Private Bridge is disabled on this server')
    const origins = status.origins ?? ['zec', 'sol']
    if (!origins.includes(from)) throw new Error(`the bridge does not accept deposits from "${from}" (offers: ${origins.join(', ')})`)
    const options = await this.bridgeReceiveOptions(from)
    const receive = p.receive ?? options[0]
    if (!options.includes(receive)) {
      throw new Error(`a deposit from "${from}" cannot become "${receive}" (offers: ${options.join(', ')})`)
    }
    const pointsAddress = p.pointsAddress === undefined ? await this.address() : p.pointsAddress
    return this.bridgeApi.createOrder(
      {
        amount: p.amount,
        origin: from,
        refundTo: p.refundTo.trim(),
        mode: 'vault',
        ...(pointsAddress ? { pointsAddress } : {}),
        receive,
      },
      // Joins this account's bridge history when signed in; the bridge works either way.
      await this.bridgeApi.ownerHeader(this.keys),
    )
  }

  /** One order, as the server sees it now. */
  bridgeOrder(token: string): Promise<BridgeOrder> {
    return this.bridgeApi.order(token)
  }

  /**
   * Finish a deposit whose funds have landed ('waiting_signature'): prove a deposit of
   * exactly what arrived, into OUR notes, and hand the proof to the server, which pays its
   * gas from the order's one-time address. The server never sees a key.
   */
  async bridgeShield(token: string, onProgress: ProgressFn = () => {}): Promise<{ txHash: string; asset: string; amount: string }> {
    this.requireKeys()
    const [order, funds] = await Promise.all([this.bridgeApi.order(token), this.bridgeApi.funds(token)])
    if (!order.vault) throw new Error('this order pays a wallet directly; there is nothing to shield')
    // The server's own recorded figure — the one its submit check compares the proof to.
    const amount = BigNumber.from(funds.arrivedWei ?? order.arrivedWei ?? funds.depositableWei)
    if (amount.isZero()) throw new Error('nothing has arrived on this order yet')
    const kind: BridgeReceive = funds.asset ?? order.receive ?? 'eth'
    const asset = kind === 'eth' ? this.nativeAsset() : bridgeAsset(await this.bridgeStatus(), kind)
    if (!asset) throw new Error(`${kind} is not available on this server`)
    this.addAsset(asset)

    return this.lock(async () => {
      const baseline = await this.lastLeafIndex(asset)
      const built = await this.buildDepositProof(asset, amount, onProgress)
      onProgress('Submitting the shielded deposit…')
      const res = await this.bridgeApi.shield(token, {
        assetId: asset.assetId.toString(),
        inEpoch: built.inEpoch,
        args: built.args,
        extData: built.extData,
      })
      onProgress('Waiting for the note to be indexed…')
      await this.waitForIndexed(asset.key, baseline)
      return { txHash: res.txHash, asset: asset.key, amount: this.formatAmount(asset, amount) }
    })
  }

  /**
   * Follow a deposit to the end: poll, shield the moment it is 'waiting_signature', and
   * return the order once it is final ('done', 'refunded', 'failed', 'expired') or the
   * timeout passes (then it is returned as it stands — nothing is lost by stopping, the
   * funds wait on the order's own address and this can be called again later).
   */
  async bridgeComplete(
    token: string,
    opts: { timeoutMs?: number; pollMs?: number; onProgress?: ProgressFn; onUpdate?: (o: BridgeOrder) => void } = {},
  ): Promise<{ order: BridgeOrder; shieldTx: string | null }> {
    const deadline = Date.now() + (opts.timeoutMs ?? 30 * 60_000)
    const pollMs = opts.pollMs ?? 10_000
    const onProgress = opts.onProgress ?? (() => {})
    let shieldTx: string | null = null
    let order = await this.bridgeApi.order(token)
    for (;;) {
      opts.onUpdate?.(order)
      if (order.status === 'waiting_signature' && !shieldTx && order.direction === 'deposit') {
        shieldTx = (await this.bridgeShield(token, onProgress)).txHash
        order = await this.bridgeApi.order(token)
        continue
      }
      if (isFinalBridgeStatus(order.status) || Date.now() >= deadline) return { order, shieldTx }
      await new Promise((r) => setTimeout(r, pollMs))
      try {
        order = await this.bridgeApi.order(token)
      } catch {
        /* transient — keep the last known state and poll again */
      }
    }
  }

  /**
   * Bridge out of the pool: a relayed withdrawal of `amount` pays the order's `payTo`, and
   * the bridge pays out on the destination chain. Nothing touches this wallet's public
   * balance. `asset` is what the vault pays: ETH, or wZEC (redeemed by the keeper; ZEC
   * destinations only). `destination` is an address on the `to` chain; `refundAddress`
   * (an EVM address here) defaults to the connected wallet.
   */
  async bridgeWithdraw(
    p: { amount: string; to?: BridgeOrigin; destination: string; asset?: 'eth' | 'wzec'; refundAddress?: string },
    onProgress: ProgressFn = () => {},
  ): Promise<{ order: BridgeOrder; txHash: string }> {
    this.requireKeys()
    const status = await this.bridgeStatus()
    if (!status.enabled) throw new Error('the Private Bridge is disabled on this server')
    const kind = p.asset ?? 'eth'
    const asset = kind === 'eth' ? this.nativeAsset() : bridgeAsset(status, kind)
    if (!asset) throw new Error(`${kind} is not available on this server`)
    const refundAddress = p.refundAddress ?? (await this.address())
    if (!refundAddress || !ethers.utils.isAddress(refundAddress)) {
      throw new Error('bridgeWithdraw needs a refundAddress (an EVM address on this chain) or a signer')
    }
    const amountWei = this.parseAmount(asset, p.amount)

    onProgress('Reserving the bridge route…')
    const order = await this.bridgeApi.createWithdrawOrder(
      { amountWei: amountWei.toString(), destination: p.destination.trim(), refundAddress, origin: p.to ?? 'zec', receive: kind },
      await this.bridgeApi.ownerHeader(this.keys),
    )
    if (!order.payTo || !ethers.utils.isAddress(order.payTo)) throw new Error('the bridge did not return a payment address')
    // The vault pays the bridge directly: one transaction, and the recipient gets exactly
    // `amount` (the relayer fee comes out of the note on top).
    const txHash = await this.withdraw(asset.key, amountWei, order.payTo, onProgress)
    return { order, txHash }
  }

  /** Where an order's money actually is (read from the chains, not the status). */
  bridgeResumePoint(token: string): Promise<BridgeResumePoint> {
    return this.bridgeApi.resumePoint(token)
  }

  /** Pick a stalled order up from wherever it stopped. 'sign' means: call bridgeShield. */
  bridgeResume(token: string): Promise<BridgeResumePoint> {
    return this.bridgeApi.resume(token)
  }

  /** This account's bridge orders, newest first (pseudonymous; needs signIn). */
  bridgeHistory(): Promise<BridgeOrder[]> {
    return this.bridgeApi.history(this.requireKeys())
  }

  /** File an order made elsewhere (another device, the web app) under this account. */
  bridgeClaim(token: string): Promise<boolean> {
    return this.bridgeApi.claim(token, this.requireKeys())
  }

  private nativeAsset(): Asset {
    const a = listAssets().find(isNativeAsset)
    if (!a) throw new Error('no native asset in the bundled deployment')
    return a
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
