// Ported from robinhood-mixer-frontend/src/lib/privacy/tree.ts. Rebuilds the user's
// per-(assetId, epoch) Merkle trees from the indexer's leaves and recovers spendable
// notes by trial-decrypting each commitment.
//
// The index in a leaf is GLOBAL across epochs:
//   epoch = index / TREE_CAPACITY   localIndex = index % TREE_CAPACITY
// Only localIndex may reach the circuit; a global index is unprovable and also feeds the
// nullifier, so getting it wrong yields an unspendable note.
import { ethers, BigNumber } from 'ethers'
import { MerkleTree } from 'fixed-merkle-tree'
import { Utxo } from './crypto/utxo.js'
import { Keypair, deriveSwapKeypair } from './crypto/keypair.js'
import { poseidonHash2, toFixedHex, MERKLE_TREE_HEIGHT, MERKLE_TREE_ZERO_VALUE } from './crypto/utils.js'
import { DEPLOYMENT } from './config.js'
import { VAULT_ABI } from './abis.js'
import type { SherwoodApi, CommitmentLeaf } from './api.js'

/** Leaves per tree — must equal the vault's capacity() (2**levels). */
export const TREE_CAPACITY = 2 ** MERKLE_TREE_HEIGHT
export const epochOf = (globalIndex: number): number => Math.floor(globalIndex / TREE_CAPACITY)
export const localIndexOf = (globalIndex: number): number => globalIndex % TREE_CAPACITY

export function emptyTree(): MerkleTree {
  return new MerkleTree(MERKLE_TREE_HEIGHT, [], {
    hashFunction: poseidonHash2 as any,
    zeroElement: MERKLE_TREE_ZERO_VALUE,
  })
}

/** Build one tree per epoch. Leaves are placed at their LOCAL index within each epoch. */
export function buildTrees(commitments: CommitmentLeaf[]): Map<number, MerkleTree> {
  const byEpoch = new Map<number, CommitmentLeaf[]>()
  for (const c of commitments) {
    const e = epochOf(c.index)
    const bucket = byEpoch.get(e)
    if (bucket) bucket.push(c)
    else byEpoch.set(e, [c])
  }
  const trees = new Map<number, MerkleTree>()
  for (const [epoch, events] of byEpoch) {
    const ordered = [...events].sort((a, b) => a.index - b.index)
    trees.set(
      epoch,
      new MerkleTree(MERKLE_TREE_HEIGHT, ordered.map((c) => c.commitment), {
        hashFunction: poseidonHash2 as any,
        zeroElement: MERKLE_TREE_ZERO_VALUE,
      }),
    )
  }
  return trees
}

export interface OwnedNotes {
  trees: Map<number, MerkleTree>
  liveEpoch: number
  notes: Utxo[]
  balance: BigNumber
}

/** The tree a note must be proved against, or an empty one if that epoch has no leaves. */
export function treeForEpoch(owned: OwnedNotes, epoch: number): MerkleTree {
  return owned.trees.get(epoch) ?? emptyTree()
}

/** `currentEpoch(assetId)` straight from the vault, or null when the RPC is unreachable. */
export async function fetchLiveEpoch(
  assetId: BigNumber,
  provider: ethers.providers.Provider,
): Promise<number | null> {
  try {
    const vault = new ethers.Contract(DEPLOYMENT.vault, VAULT_ABI, provider)
    return BigNumber.from(await vault.currentEpoch(assetId)).toNumber()
  } catch {
    return null // fall back to the leaves; a stale epoch is worse than no epoch here
  }
}

/**
 * Scan one asset's trees for this wallet's unspent notes. This is "compute your private
 * balance": trial-decrypt every commitment, keep the ones that reproduce their leaf and
 * whose nullifier is not yet spent on-chain.
 */
export async function scanNotes(
  assetId: BigNumber,
  keypair: Keypair,
  encryptionKey: Uint8Array,
  api: SherwoodApi,
  provider: ethers.providers.Provider,
): Promise<OwnedNotes> {
  const [commitments, chainEpoch] = await Promise.all([
    api.commitments(assetId),
    fetchLiveEpoch(assetId, provider),
  ])
  const spentSet = await api.nullifiers()

  const trees = buildTrees(commitments)
  let highestSeen = 0
  for (const c of commitments) {
    const e = epochOf(c.index)
    if (e > highestSeen) highestSeen = e
  }
  const liveEpoch = Math.max(highestSeen, chainEpoch ?? 0)

  const candidates: Utxo[] = []
  for (const c of commitments) {
    const epoch = epochOf(c.index)
    const local = localIndexOf(c.index)
    try {
      const utxo = await Utxo.decrypt(encryptionKey, c.encryptedOutput, local, keypair, epoch)
      // A swap-output note carries a placeholder amount in its blob (sealed before the
      // swap ran) and a one-time owner key; the indexer pins the measured amount, and we
      // recompute the key from the blinding.
      if (c.swapAmount) {
        utxo.amount = BigNumber.from(c.swapAmount)
        utxo.keypair = deriveSwapKeypair(keypair.privkey, utxo.blinding)
      }
      if (toFixedHex(utxo.getCommitment()) === c.commitment && utxo.amount.gt(0) && utxo.assetId.eq(assetId)) {
        candidates.push(utxo)
      }
    } catch {
      // not our note (AES auth failure) — skip
    }
  }

  const notes = candidates.filter((n) => !spentSet.has(toFixedHex(n.getNullifier()).toLowerCase()))
  const balance = notes.reduce((s, n) => s.add(n.amount), BigNumber.from(0))
  return { trees, liveEpoch, notes, balance }
}

const desc = (a: Utxo, b: Utxo) => (b.amount.gt(a.amount) ? 1 : -1)
const sum = (ns: Utxo[]) => ns.reduce((s, n) => s.add(n.amount), BigNumber.from(0))

export interface NoteSelection {
  epoch: number
  inputs: Utxo[]
  needsMigration: boolean
}

/**
 * Pick the notes to spend for `amount` (fee included). Circuit constraints: at most 2
 * inputs, all sharing ONE tree (one asset AND one epoch). When no single epoch covers the
 * amount but the total does, returns a migration step instead of failing.
 */
export function selectNotes(notes: Utxo[], amount: BigNumber, liveEpoch = 0): NoteSelection {
  if (sum(notes).lt(amount)) {
    throw new Error('Insufficient shielded balance for this amount plus the relayer fee')
  }
  const byEpoch = new Map<number, Utxo[]>()
  for (const n of notes) {
    const bucket = byEpoch.get(n.epoch)
    if (bucket) bucket.push(n)
    else byEpoch.set(n.epoch, [n])
  }
  const epochs = [...byEpoch.keys()].sort((a, b) => (a === liveEpoch ? -1 : b === liveEpoch ? 1 : b - a))

  for (const epoch of epochs) {
    const sorted = [...byEpoch.get(epoch)!].sort(desc)
    const inputs = sorted[0].amount.gte(amount) ? [sorted[0]] : sorted.slice(0, 2)
    if (sum(inputs).gte(amount)) return { epoch, inputs, needsMigration: false }
  }

  const oldest = epochs.filter((e) => e !== liveEpoch).sort((a, b) => a - b)[0]
  if (oldest === undefined) {
    throw new Error(
      'Your shielded balance is split across more than 2 notes; a single transaction can only spend your 2 largest. Consolidate first, or spend a smaller amount.',
    )
  }
  return {
    epoch: oldest,
    inputs: [...byEpoch.get(oldest)!].sort(desc).slice(0, 2),
    needsMigration: true,
  }
}
