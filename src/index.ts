// @sherwood-cash/sdk — headless Node SDK for the Sherwood ZK privacy pool + shielded DEX.
export { SherwoodClient } from './client.js'
export type { SherwoodClientOptions, Balance, ProgressFn } from './client.js'

export { SherwoodApi, feeForAsset } from './api.js'
export type { RelayInfo, RelayProof, RelayExtData, RelaySwapParams, CommitmentLeaf } from './api.js'

// Config / assets
export {
  DEPLOYMENT,
  DEFAULT_API_URL,
  RELAYER_ADDRESS,
  EXPLORER,
  NATIVE_ASSET_ID,
  ZERO,
  assetIdOf,
  isNativeAsset,
  isQuoteAsset,
  listAssets,
  findAsset,
} from './config.js'
export type { Asset, AssetConfig, Deployment } from './config.js'

// Low-level primitives (for devs who want to build their own flows)
export { Keypair, deriveSwapKeypair } from './crypto/keypair.js'
export { Utxo } from './crypto/utxo.js'
export { deriveKeys, signIn, encrypt, decrypt, SIGN_IN_MESSAGE } from './crypto/encryption.js'
export type { DerivedKeys } from './crypto/encryption.js'
export {
  poseidonHash,
  toFixedHex,
  getExtDataHash,
  FIELD_SIZE,
  MERKLE_TREE_HEIGHT,
  MERKLE_TREE_ZERO_VALUE,
} from './crypto/utils.js'

export { prove, ensureArtifacts } from './prover.js'
export type { ProverArtifacts, SolidityProof } from './prover.js'

export { prepareTransaction, hashSwapParams, ZERO_HASH } from './transaction.js'
export type { ProofArgs, ExtData, TransactionResult } from './transaction.js'

export {
  buildTrees,
  scanNotes,
  selectNotes,
  emptyTree,
  treeForEpoch,
  fetchLiveEpoch,
  epochOf,
  localIndexOf,
  TREE_CAPACITY,
} from './tree.js'
export type { OwnedNotes, NoteSelection } from './tree.js'

export {
  SwapVersion,
  resolveRoute,
  quoteAmountOut,
  effectiveToken,
  encodeV2Route,
  encodeV3SingleRoute,
  encodeV3MultiRoute,
  encodeV4Route,
  packV3Path,
} from './swap.js'
export type { SwapRoute } from './swap.js'

export { VAULT_ABI, ERC20_ABI, SWAP_PARAMS_TUPLE } from './abis.js'
