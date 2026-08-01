#!/usr/bin/env node
// A ~120-line MCP (Model Context Protocol) server over the Sherwood SDK, so an LLM agent
// can trade privately through tool calls over stdio. Custody is AGENT-SIDE: the wallet key
// (SHERWOOD_PRIVATE_KEY) lives in this process and never reaches the backend.
//
// Extra deps (beyond @sherwood-cash/sdk):  npm i @modelcontextprotocol/sdk zod
// Run:  SHERWOOD_PRIVATE_KEY=0x... node mcp-server.mjs
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { SherwoodClient } from '@sherwood-cash/sdk'

const PRIVATE_KEY = process.env.SHERWOOD_PRIVATE_KEY
if (!PRIVATE_KEY) {
  console.error('SHERWOOD_PRIVATE_KEY is required (the agent wallet; custody stays agent-side).')
  process.exit(1)
}

const sherwood = new SherwoodClient({
  privateKey: PRIVATE_KEY,
  apiUrl: process.env.SHERWOOD_API_URL,
  rpcUrl: process.env.SHERWOOD_RPC_URL,
})
let unlocked = null
const ready = () => (unlocked ??= sherwood.signIn())
const ok = (data) => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] })
const fail = (e) => ({ content: [{ type: 'text', text: `Error: ${e?.message ?? String(e)}` }], isError: true })

const server = new McpServer({ name: 'sherwood-cash', version: '0.1.0' })

server.tool('get_status', 'Agent address, registered assets, tree geometry and relayer fees.', {}, async () => {
  try {
    const [address, params, relay] = await Promise.all([sherwood.address(), sherwood.params(), sherwood.relayInfo()])
    return ok({ address, assets: sherwood.listAssets().map((a) => ({ key: a.key, symbol: a.symbol, decimals: a.decimals })), params, relay })
  } catch (e) { return fail(e) }
})

server.tool('get_balances', 'Shielded balances (+ spendable per asset). Pass `asset` for one, omit for all.',
  { asset: z.string().optional() },
  async ({ asset }) => { try { await ready(); return ok(asset ? await sherwood.getBalance(asset) : await sherwood.getBalances()) } catch (e) { return fail(e) } })

server.tool('quote_swap', 'Estimate the output amount for a swap, without executing it.',
  { from: z.string(), to: z.string(), amountIn: z.string() },
  async ({ from, to, amountIn }) => { try { const q = await sherwood.quote(from, to, amountIn); return q ? ok(q) : fail(new Error(`could not price ${from} -> ${to}`)) } catch (e) { return fail(e) } })

server.tool('deposit', 'Deposit an asset into the private pool. Self-signed; the wallet needs native gas.',
  { asset: z.string(), amount: z.string() },
  async ({ asset, amount }) => { try { await ready(); return ok({ txHash: await sherwood.deposit(asset, amount) }) } catch (e) { return fail(e) } })

server.tool('swap', 'Privately swap one asset for another (relayed). Auto-consolidates first. Memecoins are swap-only.',
  { from: z.string(), to: z.string(), amountIn: z.string(), slippagePct: z.number().optional(), minOut: z.string().optional() },
  async (a) => { try { await ready(); return ok(await sherwood.swap(a)) } catch (e) { return fail(e) } })

server.tool('withdraw', 'Withdraw an asset to any address (relayed; recipient gets the full amount). ETH/USDG only.',
  { asset: z.string(), amount: z.string(), recipient: z.string() },
  async ({ asset, amount, recipient }) => { try { await ready(); return ok({ txHash: await sherwood.withdraw(asset, amount, recipient) }) } catch (e) { return fail(e) } })

server.tool('consolidate', 'Merge fragmented notes so more can be spent in one transaction (quote assets only).',
  { asset: z.string(), amount: z.string().optional() },
  async ({ asset, amount }) => { try { await ready(); const txHashes = await sherwood.consolidate(asset, amount); return ok({ txHashes, steps: txHashes.length }) } catch (e) { return fail(e) } })

await server.connect(new StdioServerTransport())
console.error('Sherwood MCP server ready (stdio).')
