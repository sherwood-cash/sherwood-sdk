// Minimal ABIs the SDK needs. The vault tuples match the deployed (verified) contract:
// note the `uint32 inEpoch` on transact/executeSwap and the extra `uint256 relayerFeeOut`
// in SwapParams.
const PROOF_TUPLE =
  'tuple(uint256[2] pA, uint256[2][2] pB, uint256[2] pC, bytes32 root, bytes32[2] inputNullifiers, bytes32[2] outputCommitments, uint256 publicAmount, bytes32 extDataHash)'
const EXTDATA_TUPLE =
  'tuple(address recipient, int256 extAmount, address feeRecipient, uint256 fee, bytes encryptedOutput1, bytes encryptedOutput2, bytes32 swapParamsHash)'

// keccak256(abi.encode(SwapParams)) is bound to the proof — must match the contract byte
// for byte.
export const SWAP_PARAMS_TUPLE =
  'tuple(uint256 assetIn, address tokenOut, uint8 version, bytes routeData, uint256 minOut, uint256 deadline, bytes32 outPubkey, bytes32 outBlinding, uint256 relayerFeeOut, bytes encryptedOutput)'

export const VAULT_ABI = [
  `function transact(uint256 assetId, uint32 inEpoch, ${PROOF_TUPLE} _args, ${EXTDATA_TUPLE} _extData) payable`,
  `function executeSwap(uint32 inEpoch, ${PROOF_TUPLE} _args, ${EXTDATA_TUPLE} _extData, ${SWAP_PARAMS_TUPLE} p) returns (uint256 amountOut)`,
  'function currentEpoch(uint256 assetId) view returns (uint32)',
  'function isSpent(bytes32 nullifier) view returns (bool)',
  'function capacity() view returns (uint256)',
  'event NewCommitment(uint256 indexed assetId, bytes32 commitment, uint256 index, bytes encryptedOutput)',
  'event NewNullifier(bytes32 nullifier)',
  'event Swap(uint256 indexed assetIn, uint256 indexed assetOut, uint256 amountIn, uint256 amountOut, bytes32 commitment)',
]

export const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 value) returns (bool)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function name() view returns (string)',
  'function nonces(address owner) view returns (uint256)',
]
