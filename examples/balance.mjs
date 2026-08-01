// Read every private balance for a wallet. Run: PRIVATE_KEY=0x… node examples/balance.mjs
import { SherwoodClient } from '../dist/index.js'

const sherwood = new SherwoodClient({ privateKey: process.env.PRIVATE_KEY })
await sherwood.signIn()
console.log('address:', await sherwood.address())
for (const b of await sherwood.getBalances()) {
  console.log(`${b.symbol}: balance=${b.balance} spendable=${b.spendable} notes=${b.notes}`)
}
