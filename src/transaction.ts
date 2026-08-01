// Ported from robinhood-mixer-frontend/src/lib/privacy/transaction.ts. Produces the exact
// { args, extData } the vault's transact / executeSwap expect.
import { ethers, BigNumber } from 'ethers'
import type { MerkleTree } from 'fixed-merkle-tree'
import { Utxo } from './crypto/utxo.js'
import { prove, type ProverArtifacts } from './prover.js'
import { toFixedHex, getExtDataHash, FIELD_SIZE, MERKLE_TREE_HEIGHT } from './crypto/utils.js'
import { NATIVE_ASSET_ID } from './config.js'
import { SWAP_PARAMS_TUPLE } from './abis.js'
import type { RelaySwapParams } from './api.js'

// keccak256(abi.encode(SwapParams)) — must match SherwoodVault._requireSwapParams byte for
// byte. Goes into extData.swapParamsHash, which folds into extDataHash, which the proof
// commits to: that chain stops a relayer/front-runner replaying a proof with different
// swap params.
export function hashSwapParams(p: RelaySwapParams): string {
  return ethers.utils.keccak256(new ethers.utils.AbiCoder().encode([SWAP_PARAMS_TUPLE], [p]))
}

export interface ProofArgs {
  pA: [string, string]
  pB: [[string, string], [string, string]]
  pC: [string, string]
  root: string
  inputNullifiers: [string, string]
  outputCommitments: [string, string]
  publicAmount: string
  extDataHash: string
}

export interface ExtData {
  recipient: string
  extAmount: string
  feeRecipient: string
  fee: string
  encryptedOutput1: string
  encryptedOutput2: string
  swapParamsHash: string
}

/** ExtData.swapParamsHash for non-swap transactions; the vault requires zero there. */
export const ZERO_HASH = '0x' + '0'.repeat(64)

export interface TransactionResult {
  args: ProofArgs
  extData: ExtData
  outputs: Utxo[]
}

async function getProof(p: {
  inputs: Utxo[]
  outputs: Utxo[]
  tree: MerkleTree
  extAmount: BigNumber
  fee: BigNumber
  recipient: string | number
  feeRecipient: string | number
  encryptionKey: Uint8Array
  swapParamsHash: string
  artifacts?: ProverArtifacts
}): Promise<TransactionResult> {
  const { inputs, outputs, tree, extAmount, fee, recipient, feeRecipient, encryptionKey, swapParamsHash } = p
  const inputMerklePathIndices: number[] = []
  const inputMerklePathElements: any[] = []

  for (const input of inputs) {
    if (input.amount.gt(0)) {
      input.index = tree.indexOf(toFixedHex(input.getCommitment()))
      if (input.index < 0) throw new Error(`Input commitment ${toFixedHex(input.getCommitment())} was not found`)
      inputMerklePathIndices.push(input.index)
      inputMerklePathElements.push(tree.path(input.index).pathElements)
    } else {
      inputMerklePathIndices.push(0)
      inputMerklePathElements.push(new Array(MERKLE_TREE_HEIGHT).fill(0))
    }
  }

  const encryptedOutput1 = await outputs[0].encrypt(encryptionKey)
  const encryptedOutput2 = await outputs[1].encrypt(encryptionKey)

  const extData: ExtData = {
    recipient: toFixedHex(recipient, 20),
    extAmount: toFixedHex(extAmount),
    feeRecipient: toFixedHex(feeRecipient, 20),
    fee: toFixedHex(fee),
    encryptedOutput1,
    encryptedOutput2,
    swapParamsHash,
  }

  const extDataHash = getExtDataHash(extData)

  const input = {
    root: toFixedHex(tree.root),
    inputNullifier: inputs.map((x) => x.getNullifier().toString()),
    outputCommitment: outputs.map((x) => x.getCommitment().toString()),
    publicAmount: BigNumber.from(extAmount).sub(fee).add(FIELD_SIZE).mod(FIELD_SIZE).toString(),
    extDataHash: extDataHash.toString(),
    mintAddress: inputs[0].assetId.toString(),
    inAmount: inputs.map((x) => x.amount.toString()),
    inPrivateKey: inputs.map((x) => x.keypair.privkey.toString()),
    inBlinding: inputs.map((x) => x.blinding.toString()),
    inPathIndices: inputMerklePathIndices,
    inPathElements: inputMerklePathElements,
    outAmount: outputs.map((x) => x.amount.toString()),
    outBlinding: outputs.map((x) => x.blinding.toString()),
    outPubkey: outputs.map((x) => x.keypair.pubkey.toString()),
  }

  const { pA, pB, pC } = await prove(input, p.artifacts)

  const args: ProofArgs = {
    pA,
    pB,
    pC,
    root: toFixedHex(input.root),
    inputNullifiers: inputs.map((x) => toFixedHex(x.getNullifier())) as [string, string],
    outputCommitments: outputs.map((x) => toFixedHex(x.getCommitment())) as [string, string],
    publicAmount: toFixedHex(input.publicAmount),
    extDataHash: toFixedHex(extDataHash),
  }

  return { extData, args, outputs }
}

export async function prepareTransaction(p: {
  tree: MerkleTree
  inputs?: Utxo[]
  outputs?: Utxo[]
  fee?: BigNumber
  recipient?: string | number
  feeRecipient?: string | number
  encryptionKey: Uint8Array
  swapParamsHash?: string
  assetId?: BigNumber
  artifacts?: ProverArtifacts
}): Promise<TransactionResult> {
  const inputs = p.inputs ?? []
  const outputs = p.outputs ?? []
  const fee = p.fee ?? BigNumber.from(0)
  const ins = [...inputs]
  const outs = [...outputs]
  const padAsset = p.assetId ?? inputs[0]?.assetId ?? outputs[0]?.assetId ?? NATIVE_ASSET_ID
  while (ins.length < 2) ins.push(new Utxo({ assetId: padAsset }))
  while (outs.length < 2) outs.push(new Utxo({ assetId: padAsset }))

  const extAmount = BigNumber.from(fee)
    .add(outs.reduce((sum, x) => sum.add(x.amount), BigNumber.from(0)))
    .sub(ins.reduce((sum, x) => sum.add(x.amount), BigNumber.from(0)))

  return getProof({
    inputs: ins,
    outputs: outs,
    tree: p.tree,
    extAmount,
    fee,
    recipient: p.recipient ?? 0,
    feeRecipient: p.feeRecipient ?? 0,
    encryptionKey: p.encryptionKey,
    swapParamsHash: p.swapParamsHash ?? ZERO_HASH,
    artifacts: p.artifacts,
  })
}
