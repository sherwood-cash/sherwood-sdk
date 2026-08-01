// Ported from robinhood-mixer-frontend/src/lib/swap.ts. Builds the version-specific
// `routeData` the vault → SwapLogic pipeline expects and estimates output amounts. The
// vault operates in ERC-20 terms (it wraps native ETH to WETH), so an ETH leg is encoded
// with the WETH address.
import { ethers, BigNumber } from 'ethers'
import { DEPLOYMENT, ZERO, isNativeAsset, type Asset } from './config.js'
import type { SherwoodApi } from './api.js'

export enum SwapVersion {
  V2 = 0,
  V3 = 1,
  V4 = 2,
}

export interface SwapRoute {
  version: SwapVersion
  routeData: string
}

export function effectiveToken(asset: Asset): string {
  return isNativeAsset(asset) ? DEPLOYMENT.weth : asset.token
}

const coder = ethers.utils.defaultAbiCoder

export function encodeV2Route(from: Asset, to: Asset): SwapRoute {
  const path = [effectiveToken(from), effectiveToken(to)]
  return { version: SwapVersion.V2, routeData: coder.encode(['address[]'], [path]) }
}

export function encodeV3SingleRoute(from: Asset, to: Asset, fee: number): SwapRoute {
  const routeData = coder.encode(['address', 'address', 'uint24'], [effectiveToken(from), effectiveToken(to), fee])
  return { version: SwapVersion.V3, routeData }
}

export function packV3Path(tokens: string[], fees: number[]): string {
  if (tokens.length !== fees.length + 1) throw new Error('v3 path: tokens must be fees+1')
  let packed = '0x'
  for (let i = 0; i < fees.length; i++) {
    packed += tokens[i].slice(2)
    packed += fees[i].toString(16).padStart(6, '0')
  }
  packed += tokens[tokens.length - 1].slice(2)
  return packed
}

export function encodeV3MultiRoute(path: string): SwapRoute {
  return { version: SwapVersion.V3, routeData: coder.encode(['bytes'], [path]) }
}

export function encodeV4Route(commands: string, inputs: string[]): SwapRoute {
  return { version: SwapVersion.V4, routeData: coder.encode(['bytes', 'bytes[]'], [commands, inputs]) }
}

// ---- fee-tier resolution ----
const V3_FEE_TIERS = [100, 500, 3000, 10000]
const bestFeeCache = new Map<string, number>()
const feeKey = (a: string, b: string) => [a.toLowerCase(), b.toLowerCase()].sort().join('-')
for (const pool of DEPLOYMENT.v3Pools ?? []) bestFeeCache.set(feeKey(pool.tokenA, pool.tokenB), pool.fee)

const ROUTER_ABI = ['function factory() view returns (address)']
const FACTORY_ABI = ['function getPool(address,address,uint24) view returns (address)']
const POOL_ABI = ['function fee() view returns (uint24)', 'function liquidity() view returns (uint128)']

async function bestFeeFromBackend(api: SherwoodApi | undefined, tokenIn: string, tokenOut: string): Promise<number | null> {
  if (!api) return null
  try {
    const body = (await api.bestPool({ tokenA: tokenIn, tokenB: tokenOut })) as { fee?: number }
    return typeof body?.fee === 'number' ? body.fee : null
  } catch {
    return null
  }
}

async function deepestV3FeeOnChain(provider: ethers.providers.Provider, tokenIn: string, tokenOut: string): Promise<number | null> {
  const factoryAddr: string = await new ethers.Contract(DEPLOYMENT.routers.v3, ROUTER_ABI, provider).factory()
  const factory = new ethers.Contract(factoryAddr, FACTORY_ABI, provider)
  const found = await Promise.all(
    V3_FEE_TIERS.map(async (fee) => {
      const addr: string = await factory.getPool(tokenIn, tokenOut, fee)
      if (addr === ZERO) return null
      const liquidity = await new ethers.Contract(addr, POOL_ABI, provider).liquidity()
      return { fee, liquidity: liquidity as BigNumber }
    }),
  )
  const best = found
    .filter((x): x is { fee: number; liquidity: BigNumber } => x !== null)
    .sort((a, b) => (a.liquidity.eq(b.liquidity) ? 0 : a.liquidity.lt(b.liquidity) ? 1 : -1))[0]
  return best ? best.fee : null
}

/** Route a from→to pair through the deepest available pool (V3 preferred, then V2). */
export async function resolveRoute(from: Asset, to: Asset, provider: ethers.providers.Provider, api?: SherwoodApi): Promise<SwapRoute> {
  const tokenIn = effectiveToken(from)
  const tokenOut = effectiveToken(to)

  if (DEPLOYMENT.routers.v3 !== ZERO) {
    let fee: number | null = bestFeeCache.get(feeKey(tokenIn, tokenOut)) ?? null
    if (fee === null) fee = await bestFeeFromBackend(api, tokenIn, tokenOut)
    if (fee === null) fee = await deepestV3FeeOnChain(provider, tokenIn, tokenOut)
    if (fee !== null) {
      bestFeeCache.set(feeKey(tokenIn, tokenOut), fee)
      return encodeV3SingleRoute(from, to, fee)
    }
  }
  if (DEPLOYMENT.routers.v2 !== ZERO) return encodeV2Route(from, to)
  throw new Error(`No Uniswap pool found for ${from.symbol} → ${to.symbol}`)
}

// ---- output estimate ----
const Q96 = BigNumber.from(2).pow(96)
const QUOTER_V2_ABI = [
  'function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96)) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
]
const V2_FACTORY_ABI = ['function getPair(address,address) view returns (address)']
const V2_PAIR_ABI = ['function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32)', 'function token0() view returns (address)']

function afterProtocolFee(amount: BigNumber): BigNumber {
  const bps = DEPLOYMENT.protocolFee?.swapBps ?? 0
  return bps > 0 ? amount.mul(10_000 - bps).div(10_000) : amount
}

function quoterV3(provider: ethers.providers.Provider): ethers.Contract | null {
  const addr = DEPLOYMENT.quoters?.v3
  return addr && addr !== ZERO ? new ethers.Contract(addr, QUOTER_V2_ABI, provider) : null
}

async function quoterOut(quoter: ethers.Contract, tokenIn: string, tokenOut: string, fee: number, amountIn: BigNumber): Promise<BigNumber | null> {
  try {
    const res = await quoter.callStatic.quoteExactInputSingle({ tokenIn, tokenOut, amountIn, fee, sqrtPriceLimitX96: 0 })
    const out: BigNumber = res.amountOut ?? res[0]
    return out && out.gt(0) ? out : null
  } catch {
    return null
  }
}

async function quoteV3(provider: ethers.providers.Provider, tokenIn: string, tokenOut: string, amountIn: BigNumber): Promise<BigNumber | null> {
  const quoter = quoterV3(provider)
  if (!quoter) return null
  const key = feeKey(tokenIn, tokenOut)
  const cached = bestFeeCache.get(key)
  if (cached !== undefined) {
    const out = await quoterOut(quoter, tokenIn, tokenOut, cached, amountIn)
    if (out) return afterProtocolFee(out)
  }
  const outs = await Promise.all(V3_FEE_TIERS.map(async (fee) => ({ fee, out: await quoterOut(quoter, tokenIn, tokenOut, fee, amountIn) })))
  const best = outs.filter((x): x is { fee: number; out: BigNumber } => x.out !== null).sort((a, b) => (a.out.gt(b.out) ? -1 : 1))[0]
  if (!best) return null
  bestFeeCache.set(key, best.fee)
  return afterProtocolFee(best.out)
}

async function quoteV2(provider: ethers.providers.Provider, tokenIn: string, tokenOut: string, amountIn: BigNumber): Promise<BigNumber | null> {
  const factoryAddr: string = await new ethers.Contract(DEPLOYMENT.routers.v2, ROUTER_ABI, provider).factory()
  const pair: string = await new ethers.Contract(factoryAddr, V2_FACTORY_ABI, provider).getPair(tokenIn, tokenOut)
  if (pair === ZERO) return null
  const c = new ethers.Contract(pair, V2_PAIR_ABI, provider)
  const [reserves, token0]: [any, string] = await Promise.all([c.getReserves(), c.token0()])
  const zeroForOne = tokenIn.toLowerCase() === token0.toLowerCase()
  const reserveIn: BigNumber = zeroForOne ? reserves.reserve0 : reserves.reserve1
  const reserveOut: BigNumber = zeroForOne ? reserves.reserve1 : reserves.reserve0
  if (reserveIn.isZero() || reserveOut.isZero()) return null
  const inWithFee = amountIn.mul(997)
  const out = inWithFee.mul(reserveOut).div(reserveIn.mul(1000).add(inWithFee))
  return out.gt(0) ? afterProtocolFee(out) : null
}

/** Estimate the output-token amount for a from→to swap of `amountIn` (base units). */
export async function quoteAmountOut(from: Asset, to: Asset, amountIn: BigNumber, provider: ethers.providers.Provider): Promise<BigNumber | null> {
  if (amountIn.lte(0)) return null
  const tokenIn = effectiveToken(from)
  const tokenOut = effectiveToken(to)
  if (DEPLOYMENT.routers.v3 !== ZERO) {
    try {
      const v3 = await quoteV3(provider, tokenIn, tokenOut, amountIn)
      if (v3) return v3
    } catch {
      /* fall through to V2 */
    }
  }
  if (DEPLOYMENT.routers.v2 !== ZERO) {
    try {
      return await quoteV2(provider, tokenIn, tokenOut, amountIn)
    } catch {
      return null
    }
  }
  return null
}
