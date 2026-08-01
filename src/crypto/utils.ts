// Ported from robinhood-mixer-frontend/src/lib/privacy/utils.ts — identical hashing &
// encoding so proofs generated here verify against the same on-chain Verifier2.
// (crypto.getRandomValues is a Node ≥ 20 global, so this runs headless unchanged.)
import { ethers, BigNumber } from 'ethers'
import { poseidon1, poseidon2, poseidon3, poseidon4 } from 'poseidon-lite'

export function poseidonHash(items: any[]): BigNumber {
  if (items.length === 1) return BigNumber.from(poseidon1(items))
  if (items.length === 2) return BigNumber.from(poseidon2(items))
  if (items.length === 3) return BigNumber.from(poseidon3(items))
  if (items.length === 4) return BigNumber.from(poseidon4(items))
  throw new Error(`Unsupported poseidon input length: ${items.length}`)
}

export const poseidonHash2 = (a: any, b: any) => poseidonHash([a, b])

export const FIELD_SIZE = BigNumber.from(
  '21888242871839275222246405745257275088548364400416034343698204186575808495617',
)

export function randomBN(nbytes = 31): BigNumber {
  const bytes = new Uint8Array(nbytes)
  crypto.getRandomValues(bytes)
  return BigNumber.from(bytes)
}

export function toFixedHex(number: any, length = 32): string {
  let result = '0x' + BigNumber.from(number).toHexString().replace('0x', '').padStart(length * 2, '0')
  if (result.indexOf('-') > -1) {
    result = '-' + result.replace('-', '')
  }
  return result
}

export function getExtDataHash(extData: {
  recipient: string
  extAmount: any
  feeRecipient: string
  fee: any
  encryptedOutput1: string
  encryptedOutput2: string
  swapParamsHash: string
}): BigNumber {
  const abi = new ethers.utils.AbiCoder()
  const encodedData = abi.encode(
    [
      'tuple(address recipient,int256 extAmount,address feeRecipient,uint256 fee,bytes encryptedOutput1,bytes encryptedOutput2,bytes32 swapParamsHash)',
    ],
    [
      {
        recipient: toFixedHex(extData.recipient, 20),
        extAmount: toFixedHex(extData.extAmount),
        feeRecipient: toFixedHex(extData.feeRecipient, 20),
        fee: toFixedHex(extData.fee),
        encryptedOutput1: extData.encryptedOutput1,
        encryptedOutput2: extData.encryptedOutput2,
        swapParamsHash: extData.swapParamsHash,
      },
    ],
  )
  const hash = ethers.utils.keccak256(encodedData)
  return BigNumber.from(hash).mod(FIELD_SIZE)
}

export const MERKLE_TREE_HEIGHT = 26
export const MERKLE_TREE_ZERO_VALUE =
  '2795675251356313514992617062594790716374808130983166135938897961178374655502'
