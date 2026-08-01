// Ported verbatim from robinhood-mixer-frontend/src/lib/privacy/keypair.ts.
// Must stay byte-identical to deriveSwapKeypair in the contracts repo, or swap-output
// notes become unspendable.
import { ethers, BigNumber } from 'ethers'
import { poseidonHash, toFixedHex, FIELD_SIZE } from './utils.js'

// Domain tag for swap-output note keys. Derived from a string rather than a literal so
// this and the contracts repo cannot drift apart.
const SWAP_NOTE_KEY_DOMAIN = BigNumber.from(
  ethers.utils.keccak256(ethers.utils.toUtf8Bytes('sherwood.swap.notekey.v1')),
).mod(FIELD_SIZE)

const swapNoteKeySeed = (privkey: BigNumber | string) =>
  poseidonHash([BigNumber.from(privkey), SWAP_NOTE_KEY_DOMAIN])

export class Keypair {
  privkey: string
  pubkey: BigNumber

  constructor(privkey: string = ethers.Wallet.createRandom().privateKey) {
    this.privkey = privkey
    this.pubkey = poseidonHash([this.privkey])
  }

  toString() {
    return toFixedHex(this.pubkey)
  }

  address() {
    return this.toString()
  }

  sign(commitment: any, merklePath: any): BigNumber {
    return poseidonHash([this.privkey, commitment, merklePath])
  }
}

/**
 * The ONE-TIME keypair that owns a swap-output note. `SwapParams.outPubkey` is the only
 * place a note's P appears in the clear, so a fresh P per swap (derived from the wallet
 * key + the note's blinding) keeps a wallet's swaps unlinkable while still recoverable on
 * any device holding the wallet key.
 */
export function deriveSwapKeypair(privkey: BigNumber | string, blinding: BigNumber | string): Keypair {
  return new Keypair(toFixedHex(poseidonHash([swapNoteKeySeed(privkey), BigNumber.from(blinding)])))
}
