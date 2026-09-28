// Bridge ZEC / SOL / BTC privately into the pool, or back out.
//
//   PRIVATE_KEY=0x… node examples/bridge.mjs quote btc 0.01
//   PRIVATE_KEY=0x… node examples/bridge.mjs in zec 1.5 t1YourRefundAddr [eth|wzec]
//   PRIVATE_KEY=0x… node examples/bridge.mjs out zec 0.2 t1YourPayoutAddr [eth|wzec]
//   PRIVATE_KEY=0x… node examples/bridge.mjs follow <order-token>
import { SherwoodClient } from '../dist/index.js'

const [cmd, a, b, c, d] = process.argv.slice(2)
const sherwood = new SherwoodClient({ privateKey: process.env.PRIVATE_KEY })
await sherwood.signIn()
const log = (m) => console.log(' ', m)

if (cmd === 'quote') {
  console.log(await sherwood.bridgeQuote({ from: a, amount: b }))
} else if (cmd === 'in') {
  const order = await sherwood.bridgeDeposit({ from: a, amount: b, refundTo: c, receive: d })
  console.log(`Send ${order.amountInFormatted} ${a.toUpperCase()} to ${order.depositAddress}` + (order.depositMemo ? ` (memo ${order.depositMemo})` : ''))
  console.log(`Order ${order.token} — waiting for it to land, then shielding…`)
  const { order: final, shieldTx } = await sherwood.bridgeComplete(order.token, { onProgress: log, onUpdate: (o) => log(o.status) })
  console.log(final.status, shieldTx ?? '')
} else if (cmd === 'out') {
  const { order, txHash } = await sherwood.bridgeWithdraw({ to: a, amount: b, destination: c, asset: d }, log)
  console.log(`Withdrawal ${txHash} paid the bridge; order ${order.token} pays ${order.amountOutFormatted} to ${c}`)
} else if (cmd === 'follow') {
  const { order, shieldTx } = await sherwood.bridgeComplete(a, { onProgress: log, onUpdate: (o) => log(o.status) })
  console.log(order.status, shieldTx ?? '')
} else {
  console.log('usage: quote | in | out | follow — see the header of this file')
}
process.exit(0)
