import { BigNumber } from 'ethers'
import deployment from './deployment.json' with { type: 'json' }

// The native ETH sentinel used on-chain (SherwoodVault.NATIVE_ASSET_ID = 1). Native
// ETH lives in tree assetId = 1, with token address(0) internally.
export const NATIVE_ASSET_ID = BigNumber.from(1)
export const ZERO = '0x0000000000000000000000000000000000000000'

export interface AssetConfig {
  token: string
  decimals: number
  native: boolean
}

export interface Deployment {
  network: string
  chainId: number
  rpcUrl: string
  deployBlock: number
  merkleTreeHeight: number
  vault: string
  swapLogic: string
  weth: string
  routers: { v2: string; v3: string; v4: string }
  quoters?: { v3?: string; v4?: string }
  v3Pools?: { tokenA: string; tokenB: string; fee: number }[]
  nativeCurrency: { name: string; symbol: string; decimals: number }
  protocolFee?: { swapBps: number; withdrawBps: number; recipient: string; feeAssets: string[] }
  assets: Record<string, AssetConfig>
}

export const DEPLOYMENT = deployment as unknown as Deployment

// Live deployment addresses (bundled defaults; override via SherwoodClient options).
export const DEFAULT_API_URL = 'https://api.sherwood.cash'
export const RELAYER_ADDRESS = '0xf8F825e3840bA0A76C7E23E78dA7Cf6444D8d2c0'
export const EXPLORER = 'https://robinhoodchain.blockscout.com'

/** A registered asset the SDK knows about, resolved from its config key. */
export interface Asset {
  key: string
  symbol: string
  token: string // ERC-20 address, or the zero address for native ETH
  decimals: number
  native: boolean
  assetId: BigNumber // uint256(uint160(token)); native ETH = 1
}

// assetId = uint256(uint160(token)); native ETH uses the sentinel (assetId = 1).
export function assetIdOf(token: string): BigNumber {
  if (!token || token.toLowerCase() === ZERO) return NATIVE_ASSET_ID
  return BigNumber.from(token)
}

export function isNativeAsset(a: { native: boolean; token: string }): boolean {
  return a.native || a.token.toLowerCase() === ZERO
}

// Quote assets are the pool's dollar/ETH legs — the only side the vault will pay the
// relayer fee on. Derived from protocolFee.feeAssets.
const QUOTE_KEYS = new Set(DEPLOYMENT.protocolFee?.feeAssets ?? ['eth', 'usdg'])
export function isQuoteAsset(a: Asset): boolean {
  return QUOTE_KEYS.has(a.key)
}

/** All registered assets from the bundled deployment, as resolved Asset objects. */
export function listAssets(): Asset[] {
  return Object.entries(DEPLOYMENT.assets).map(([key, cfg]) => resolveAsset(key, cfg))
}

function resolveAsset(key: string, cfg: AssetConfig): Asset {
  return {
    key,
    symbol: key.toUpperCase(),
    token: cfg.token,
    decimals: cfg.decimals,
    native: cfg.native,
    assetId: assetIdOf(cfg.token),
  }
}

/** Resolve an asset by config key ("eth"), symbol, or token address. */
export function findAsset(idOrKey: string): Asset | undefined {
  const q = idOrKey.toLowerCase()
  return listAssets().find(
    (a) => a.key.toLowerCase() === q || a.symbol.toLowerCase() === q || a.token.toLowerCase() === q,
  )
}
