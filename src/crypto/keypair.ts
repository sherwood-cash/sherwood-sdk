// Ported verbatim from robinhood-mixer-frontend/src/lib/privacy/keypair.ts.
// Must stay byte-identical to deriveTemporaryKeypair in the contracts repo, or swap-output
// notes become unspendable.
import { ethers, BigNumber } from 'ethers'
import { poseidonHash, toFixedHex, FIELD_SIZE } from './utils.js'

// Domain tag for one-time note keys (swap outputs and reward-claim outputs). The
// string still says "swap" and must NEVER change: every existing swap note's key hangs
// off it. Derived from a string rather than a literal so
// this and the contracts repo cannot drift apart.
const TEMPORARY_KEY_DOMAIN = BigNumber.from(
  ethers.utils.keccak256(ethers.utils.toUtf8Bytes('sherwood.swap.notekey.v1')),
).mod(FIELD_SIZE)

const temporaryKeySeed = (privkey: BigNumber | string) =>
  poseidonHash([BigNumber.from(privkey), TEMPORARY_KEY_DOMAIN])

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
 * The ONE-TIME keypair that owns a note whose pubkey goes public: a swap output, or the
 * re-emitted note of a reward claim. `SwapParams.outPubkey` is the only
 * place a note's P appears in the clear, so a fresh P per swap (derived from the wallet
 * key + the note's blinding) keeps a wallet's swaps unlinkable while still recoverable on
 * any device holding the wallet key.
 */
export function deriveTemporaryKeypair(privkey: BigNumber | string, blinding: BigNumber | string): Keypair {
  return new Keypair(toFixedHex(poseidonHash([temporaryKeySeed(privkey), BigNumber.from(blinding)])))
}
