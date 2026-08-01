// Ported from robinhood-mixer-frontend/src/lib/privacy/encryption.ts.
//
// AES-256-GCM via WebCrypto (a Node ≥ 20 global). Wire format is identical to the
// frontend / indexer: [IV(12)] + [authTag(16)] + [ct], so notes written here stay
// decryptable by the web app and vice-versa. The browser-only sign-in cache is dropped;
// key derivation is pure and deterministic per wallet signature.
import { ethers } from 'ethers'
import { Keypair } from './keypair.js'

export const SIGN_IN_MESSAGE = 'Sherwood Cash account sign in'

export interface DerivedKeys {
  encryptionKey: Uint8Array
  utxoPrivateKey: string
  keypair: Keypair
}

/**
 * Derive the account's private keys from a signature over SIGN_IN_MESSAGE. The message is
 * a fixed string, so the signature — and therefore the keys — are deterministic per
 * wallet: the same wallet always yields the same shielded account on any device.
 */
export function deriveKeys(signature: string): DerivedKeys {
  const encryptionKeyHex = ethers.utils.keccak256(signature)
  const encryptionKey = hexToBytes(encryptionKeyHex)
  const utxoPrivateKey = ethers.utils.keccak256(encryptionKey)
  const keypair = new Keypair(utxoPrivateKey)
  return { encryptionKey, utxoPrivateKey, keypair }
}

/** Sign SIGN_IN_MESSAGE with the given signer and derive the shielded account keys. */
export async function signIn(signer: ethers.Signer): Promise<DerivedKeys> {
  const signature = await signer.signMessage(SIGN_IN_MESSAGE)
  return deriveKeys(signature)
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/^0x/, '')
  const out = new Uint8Array(clean.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  return out
}

function bytesToHex(bytes: Uint8Array): string {
  return '0x' + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

async function importKey(encryptionKey: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', encryptionKey as BufferSource, { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ])
}

export async function encrypt(data: string, encryptionKey: Uint8Array): Promise<string> {
  const key = await importKey(encryptionKey)
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const plaintext = new TextEncoder().encode(data)
  const buf = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, plaintext as BufferSource),
  )
  // WebCrypto returns ciphertext||tag; split the trailing 16-byte tag back out.
  const tag = buf.slice(buf.length - 16)
  const ct = buf.slice(0, buf.length - 16)
  const result = new Uint8Array(iv.length + tag.length + ct.length)
  result.set(iv, 0)
  result.set(tag, iv.length)
  result.set(ct, iv.length + tag.length)
  return bytesToHex(result)
}

export async function decrypt(encryptedData: string, encryptionKey: Uint8Array): Promise<string> {
  const key = await importKey(encryptionKey)
  const buf = hexToBytes(encryptedData)
  const iv = buf.slice(0, 12)
  const tag = buf.slice(12, 28)
  const ct = buf.slice(28)
  const combined = new Uint8Array(ct.length + tag.length)
  combined.set(ct, 0)
  combined.set(tag, ct.length)
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: iv as BufferSource },
    key,
    combined as BufferSource,
  )
  return new TextDecoder().decode(plaintext)
}
