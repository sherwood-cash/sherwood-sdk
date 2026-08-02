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
