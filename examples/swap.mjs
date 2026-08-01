// Deposit → swap → withdraw. Run: PRIVATE_KEY=0x… node examples/swap.mjs
import { SherwoodClient } from '../dist/index.js'

const sherwood = new SherwoodClient({ privateKey: process.env.PRIVATE_KEY })
await sherwood.signIn()

console.log('quote:', await sherwood.quote('eth', 'usdg', '0.01'))
// await sherwood.deposit('eth', '0.05')
// const { amountOut } = await sherwood.swap({ from: 'eth', to: 'usdg', amountIn: '0.02', slippagePct: 1 })
// console.log('got', amountOut, 'USDG')
// await sherwood.withdraw('usdg', '10', '0xYourAddress')
