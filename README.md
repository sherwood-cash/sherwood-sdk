# @sherwood-cash/sdk

Headless Node SDK for **[Sherwood Cash](https://sherwood.cash)** — a multi-asset ZK
privacy pool + shielded DEX on the Robinhood Chain. Deposit, compute your private balance,
swap and withdraw from a script, a backend, or an autonomous agent — **no browser, no
custodian**. Every proof is generated locally; no key ever leaves your process.

It ports the web app's reference implementation (`privacy/*` + `actions.ts`) to Node and
adds the note-lifecycle handling an unattended agent needs: automatic consolidation,
per-account serialization, local proof verification, and indexed-note waiting.

> Runs on **Node ≥ 20** (uses global WebCrypto). It does **not** run on Bun — snarkjs
> crashes there. If your app is a Bun project, run the SDK as a separate Node process.

## Install

```bash
npm install @sherwood-cash/sdk
```

The Groth16 circuit artifacts (`transaction2.wasm` ~3 MB, `transaction2.zkey` ~16 MB) are
**not** bundled. On first proof they are downloaded from the public Sherwood CDN and cached
under `~/.sherwood-sdk/circuits`. To run fully offline, set `SHERWOOD_WASM_PATH` and
`SHERWOOD_ZKEY_PATH` (or pass `artifacts` to the client).

## Quick start

```ts
import { SherwoodClient } from '@sherwood-cash/sdk'

const sherwood = new SherwoodClient({ privateKey: process.env.PRIVATE_KEY })

// Unlock the shielded account (one deterministic signature per wallet).
await sherwood.signIn()

// 1. Deposit 0.05 ETH into the pool (self-signed; needs native gas).
await sherwood.deposit('eth', '0.05')

// 2. Read your PRIVATE balance (scans + trial-decrypts your notes).
console.log(await sherwood.getBalance('eth'))
// { asset:'eth', balance:'0.05', spendable:'0.05', notes:1, liveEpoch:0, ... }

// 3. Privately swap 0.02 ETH -> USDG (relayed; 1% slippage by default).
const { amountOut } = await sherwood.swap({ from: 'eth', to: 'usdg', amountIn: '0.02' })

// 4. Withdraw 10 USDG to any address (relayed; recipient gets the full amount).
await sherwood.withdraw('usdg', '10', '0xRecipient…')
```

## How it works

- **Deposits** are signed by your own EOA and pay gas. Everything else — **withdraw**,
  **swap**, **consolidate** — is **relayed**: the relayer pays gas and reimburses itself in
  the asset, so your address never appears next to your nullifiers on-chain.
- Your **private balance** is the set of unspent notes you own. `getBalance` fetches the
  asset's Merkle leaves from the indexer, trial-decrypts each with your key, and sums the
  ones that are still unspent.
- The pool keeps **one Merkle tree per (asset, epoch)**. A single transaction can only
  spend ≤ 2 notes from **one** tree, so the SDK **auto-consolidates** fragmented balances
  before a spend and exposes `spendable` (what you can move in one tx) alongside `balance`.
- Every generated proof is **verified locally** (`groth16.verify`) before it is submitted.

## API

### `new SherwoodClient(options)`

| option       | description                                                              |
|--------------|--------------------------------------------------------------------------|
| `privateKey` | EVM private key. A `Wallet` is created from it. Required for deposits.    |
| `signer`     | An ethers `Signer`, if you prefer to supply your own.                    |
| `apiUrl`     | Backend base URL. Default `https://api.sherwood.cash`.                    |
| `rpcUrl`     | JSON-RPC for chain reads. Sensible default baked in.                     |
| `artifacts`  | `{ wasm?, zkey?, cacheDir? }` — override circuit artifact locations.      |

### Methods

- `signIn(signature?)` — derive the shielded account keys (deterministic per wallet).
- `listAssets()` / `asset(idOrKey)` — the registered assets (`eth`, `usdg`, memecoins…).
- `getBalance(asset)` → `{ balance, spendable, notes, liveEpoch, ... }`.
- `getBalances()` — the above for every asset.
- `quote(from, to, amountIn)` → estimated output (on-chain Uniswap V3/V2 quote).
- `deposit(asset, amount)` → txHash. Self-signed; native gas required.
- `swap({ from, to, amountIn, minOut?, slippagePct?, route? })` → `{ txHash, amountOut }`.
- `withdraw(asset, amount, recipient)` → txHash.
- `consolidate(asset, amount?)` / `consolidateUntilSpendable(asset, target)` → txHashes.
- `waitForIndexed(asset, minLeafIndex)` — block until a new note is indexed (spendable).
- `params()` / `relayInfo()` — tree geometry and relayer fees.

Amounts accept a human-readable string (`'0.05'`) or a base-unit `BigNumber`.

### Low-level primitives

For devs building custom flows, the SDK also exports `Keypair`, `Utxo`, `deriveKeys`,
`scanNotes`, `selectNotes`, `buildTrees`, `prepareTransaction`, `prove`, the routing
helpers (`resolveRoute`, `quoteAmountOut`, `encodeV3SingleRoute`, …), the ABIs, and the
`SherwoodApi` HTTP client.

## Private Bridge (ZEC / SOL / BTC)

Bring ZEC, SOL or BTC straight into a **shielded** balance, or pay a shielded balance out to
one of those chains, without the wallet ever showing up on chain.

```ts
await sherwood.signIn()

// IN: open an order, send the coin to its deposit address, let the SDK shield it.
const order = await sherwood.bridgeDeposit({
  from: 'btc',               // 'zec' | 'sol' | 'btc'
  amount: '0.01',
  refundTo: 'bc1q…',         // an address ON THE ORIGIN CHAIN, for a failed bridge
  receive: 'cbbtc',          // 'eth' | 'wzec' (from zec/sol) | 'cbbtc' = wBTC (from btc)
})
// → send order.amountInFormatted to order.depositAddress (+ order.depositMemo if set)
const { order: final } = await sherwood.bridgeComplete(order.token) // polls, then shields

// OUT: one relayed withdrawal pays the bridge; the coin arrives on the other chain.
await sherwood.bridgeWithdraw({ to: 'zec', amount: '0.2', destination: 't1…', asset: 'eth' })
```

How it stays private: a deposit is always a **vault order**. The bridge pays a one-time
address the server derives; when the funds land (`waiting_signature`) the SDK builds a
deposit proof for exactly what arrived, **locally, from your note keys**, and the server
pays its gas from that one-time address. The server funds a note it can neither read nor
spend. An exit is a normal relayed withdrawal whose recipient is the order's `payTo`.

| method | what it does |
|---|---|
| `bridgeStatus()` | origins, receive modes, confidentiality; registers wZEC / cbBTC as assets |
| `bridgeQuote({ amount, from, receive })` | what a deposit becomes, and roughly how long it takes |
| `bridgeDeposit({ amount, from, refundTo, receive? })` | open a vault order → deposit address |
| `bridgeComplete(token, { timeoutMs? })` | poll and shield when ready; returns the final order |
| `bridgeShield(token)` | shield now (order must be `waiting_signature`) |
| `bridgeWithdraw({ amount, to, destination, asset?, refundAddress? })` | bridge out of the pool |
| `bridgeOrder(token)` / `bridgeResume(token)` / `bridgeResumePoint(token)` | track / unstick an order |
| `bridgeHistory()` / `bridgeClaim(token)` | orders filed under your pseudonym |

Nothing is lost by stopping mid-way: the funds wait on the order's own address, and
`bridgeComplete(token)` picks it up later. The history hangs off a pseudonym derived from
the note encryption key (`sherwood.zcash.identity.v1`), identical to the web app's, so an
agent and a browser on the same wallet see the same orders. See `examples/bridge.mjs`.

## Solana

The same pool also runs on **Solana** (same circuit, same note keys). Everything lives under the
`solana` namespace: plain functions rather than a client class. Amounts are `bigint`s in base units
(lamports for SOL, 10^-6 for USDC). `'SOL'` is accepted anywhere a mint is expected.

### Setup

```ts
import { solana } from '@sherwood-cash/sdk'
import { Keypair, VersionedTransaction, Transaction } from '@solana/web3.js'
import nacl from 'tweetnacl'

solana.configureSolana({
  apiUrl: 'https://api.sherwood.cash',                         // default
  programId: 'GiZYK8HpC75FGAAamAiJryMrykGQAJ91gEGGtxzgtCmJ',  // mainnet: pin it, so a hostile backend cannot redirect deposits
  // rpcUrl: 'https://…',   // optional, defaults to the public RPC of the backend's cluster
  // artifacts: { wasm, zkey }, // optional, same circuit files as the EVM client
})

// Any object with publicKey + signTransaction works (wallet adapter, Keypair wrapper…).
const kp = Keypair.fromSecretKey(/* your 64-byte secret */)
const wallet: solana.SolanaWallet = {
  publicKey: kp.publicKey,
  async signTransaction(tx) {
    tx instanceof VersionedTransaction ? tx.sign([kp]) : (tx as Transaction).partialSign(kp)
    return tx
  },
}

// Shielded account keys: one deterministic ed25519 signature, same account on every device.
const keys = await solana.deriveSolanaKeys(async (msg) => nacl.sign.detached(msg, kp.secretKey))
```

### Actions

```ts
const SOL = 'SOL'
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'

// Public wallet balances, per configured mint.
await solana.walletBalances(wallet.publicKey)

// Deposit 0.1 SOL. Signed and paid by YOUR wallet (needs SOL for rent + fees).
await solana.deposit({ keys, wallet, mint: SOL, amount: 100_000_000n })

// Private balance: scans the trees and trial-decrypts your notes.
const { balance, notes } = await solana.scanNotes(keys, SOL)

// Private swap SOL -> USDC. Relayed: your wallet never appears.
const quote = await solana.quoteSwap({ mintIn: SOL, mintOut: USDC, amountIn: 50_000_000n })
await solana.swap({ keys, mintIn: SOL, mintOut: USDC, amountIn: 50_000_000n, quote, slippageBps: 100 })

// Withdraw 5 USDC to any address. Relayed; protocol + relayer fees come out of the notes.
await solana.withdraw({ keys, mint: USDC, amount: 5_000_000n, recipient: '<base58 address>' })

// Consolidate notes (into the live epoch). Returns null when there is nothing to merge.
await solana.merge({ keys, mint: USDC })
```

Every action returns the transaction signature.

- **Which side signs:** `deposit` is signed by your wallet. `withdraw`, `swap` and `merge` are
  proved locally and POSTed to `/solana/relay`, so the fee payer is the relayer.
- **Quote assets only** (`quote: true` in `solana.getSolanaParams().assets`) can be deposited or withdrawn. Other tokens are
  swap-only: swap them back to a quote first. The same call returns the fees.
- **`SolanaMergeRequired`**: thrown when the balance is split across epochs or more than 2 notes.
  Call `merge()` and retry. Merging a non-quote token needs `wallet` (it cannot pay a relayer fee).
- **`SolanaInsufficientSol`**: the wallet cannot cover the deposit's rent + fees (`need` / `have` in lamports).
- **Tests and self-hosting:** each function takes an optional last `ctx` argument
  (`{ params, source, connection, submit }`) to override the backend.

## Notes for agents

- **Custody is yours.** The backend never holds a key; it only serves note data and relays
  signed proofs. Keep your private key in the agent process.
- Actions on one account are **serialized** internally, so concurrent calls never pick the
  same notes (which would revert with a duplicate nullifier).
- A freshly created note is unspendable until the indexer has its leaf index. The mutating
  methods already `waitForIndexed`, so back-to-back actions are safe — but this bounds the
  minimum cycle time. This is not built for HFT.
- Memecoins are **swap-only**: sell them back to a quote asset (ETH/USDG) to withdraw. The
  relayer only quotes a non-zero fee for ETH and USDG.

## MCP server

For LLM agents, an MCP (Model Context Protocol) server built on this SDK lives in its own
repo: **[sherwood-cash/sherwood-mcp](https://github.com/sherwood-cash/sherwood-mcp)**. It
exposes `get_status`, `get_balances`, `quote_swap`, `deposit`, `swap`, `withdraw` and
`consolidate` as tools; custody stays agent-side via `SHERWOOD_PRIVATE_KEY`.

## License

MIT
