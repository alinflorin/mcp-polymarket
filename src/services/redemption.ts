/**
 * Position Redemption Service
 * Handles redemption of resolved market positions on Polymarket
 */

import { type BigNumber, Contract, providers, utils, Wallet } from "ethers";
import { getConfig, POLYGON_ADDRESSES } from "./config.js";

// Parent collection ID for Polymarket (constant)
const PARENT_COLLECTION_ID =
	"0x0000000000000000000000000000000000000000000000000000000000000000";

/**
 * CTF (Conditional Tokens Framework) ABI for redemption operations
 */
const CTF_ABI = [
	"function balanceOf(address account, uint256 id) view returns (uint256)",
	"function payoutDenominator(bytes32 conditionId) view returns (uint256)",
	"function payoutNumerators(bytes32 conditionId, uint256 index) view returns (uint256)",
	"function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets)",
	"function isApprovedForAll(address owner, address operator) view returns (bool)",
];

/**
 * NegRiskAdapter ABI for negative risk market redemption
 */
const NEG_RISK_ADAPTER_ABI = [
	"function redeemPositions(bytes32 conditionId, uint256[] amounts)",
];

/**
 * ProxyWallet ABI — the on-chain proxy owned by your EOA.
 * typeCode: 1 = CALL, 2 = DELEGATECALL
 */
const PROXY_WALLET_ABI = [
	"function proxy(tuple(uint8 typeCode, address to, uint256 value, bytes data)[] calls) payable returns (bytes[] returnValues)",
];

const CALL_TYPE = 1; // ProxyWalletLib.CallType.CALL

export interface RedeemResult {
	success: boolean;
	txHash?: string;
	error?: string;
}

export interface RedeemParams {
	conditionId: string;
	tokenId?: string;
	outcomeIndex?: 0 | 1;
	negRisk?: boolean;
}

/**
 * Redemption service class
 */
export class PolymarketRedemption {
	private signer: Wallet;
	private provider: providers.JsonRpcProvider;
	private cfg: ReturnType<typeof getConfig>;

	constructor(signer?: Wallet) {
		this.cfg = getConfig();
		if (!this.cfg.privateKey) {
			throw new Error(
				"POLYMARKET_PRIVATE_KEY environment variable is required for redemption",
			);
		}
		// Use StaticJsonRpcProvider to completely skip network auto-detection
		this.provider = new providers.StaticJsonRpcProvider(
			this.cfg.rpcUrl,
			this.cfg.chainId,
		);
		this.signer = signer ?? new Wallet(this.cfg.privateKey, this.provider);
	}

	/**
	 * Whether to route calls through the ProxyWallet contract.
	 * For POLY_PROXY (sig type 1) with a funderAddress set, all on-chain calls
	 * must be sent via proxy(calls[]) — direct EOA calls operate on the EOA's
	 * (empty) token balance, not the proxy wallet's balance.
	 */
	private get useProxy(): boolean {
		return !!(this.cfg.funderAddress && this.cfg.signatureType === 1);
	}

	/**
	 * Get the wallet address that actually holds the tokens.
	 * For proxy wallets this is funderAddress; for EOA it's the signer.
	 */
	getWalletAddress(): string {
		return this.cfg.funderAddress ?? this.signer.address;
	}

	/**
	 * Get CTF contract instance (read-only calls always go direct).
	 */
	private getCtfContract(): Contract {
		return new Contract(POLYGON_ADDRESSES.CTF_ADDRESS, CTF_ABI, this.signer);
	}

	/**
	 * Get NegRiskAdapter contract instance.
	 */
	private getNegRiskAdapterContract(): Contract {
		return new Contract(
			POLYGON_ADDRESSES.NEG_RISK_ADAPTER_ADDRESS,
			NEG_RISK_ADAPTER_ABI,
			this.signer,
		);
	}

	/**
	 * Get ProxyWallet contract instance (the funderAddress proxy).
	 */
	private getProxyWalletContract(): Contract {
		if (!this.cfg.funderAddress) {
			throw new Error("funderAddress is required for proxy wallet calls");
		}
		return new Contract(
			this.cfg.funderAddress,
			PROXY_WALLET_ABI,
			this.signer,
		);
	}

	/**
	 * Send a transaction either directly (EOA) or via the ProxyWallet (sig type 1).
	 *
	 * @param targetAddress  The contract to call (CTF or NegRiskAdapter)
	 * @param calldata       ABI-encoded function call
	 * @param gasLimit       Gas limit for the call
	 */
	private async sendTx(
		targetAddress: string,
		calldata: string,
		gasLimit = 400_000,
	): Promise<providers.TransactionResponse> {
		const overrides = {
			gasLimit,
			maxFeePerGas: utils.parseUnits("250", "gwei"),
			maxPriorityFeePerGas: utils.parseUnits("50", "gwei"),
		};

		if (this.useProxy) {
			const proxyWallet = this.getProxyWalletContract();
			const calls = [
				{
					typeCode: CALL_TYPE,
					to: targetAddress,
					value: 0,
					data: calldata,
				},
			];
			console.log(`📡 Routing redemption through ProxyWallet (${this.cfg.funderAddress})`);
			return proxyWallet.proxy(calls, overrides);
		}

		// Direct EOA call
		return this.signer.sendTransaction({
			to: targetAddress,
			data: calldata,
			...overrides,
		});
	}

	/**
	 * Get CTF token balance for a specific position.
	 */
	async getCTFBalance(tokenId: string): Promise<bigint> {
		const ctf = this.getCtfContract();
		const walletAddress = this.getWalletAddress();
		const balance: BigNumber = await ctf.balanceOf(walletAddress, tokenId);
		return balance.toBigInt();
	}

	/**
	 * Check if a market condition has been resolved.
	 */
	async isMarketResolved(conditionId: string): Promise<boolean> {
		const ctf = this.getCtfContract();
		const conditionIdBytes32 = this.formatConditionId(conditionId);
		const payoutDenominator: BigNumber =
			await ctf.payoutDenominator(conditionIdBytes32);
		return payoutDenominator.gt(0);
	}

	/**
	 * Get winning outcome index sets for a resolved binary market.
	 * Returns array of index sets where payout numerator > 0.
	 * For binary markets: [1] for first outcome won, [2] for second outcome won.
	 */
	async getWinningIndexSets(conditionId: string): Promise<bigint[]> {
		const ctf = this.getCtfContract();
		const conditionIdBytes32 = this.formatConditionId(conditionId);

		const [numerator0, numerator1]: [BigNumber, BigNumber] = await Promise.all([
			ctf.payoutNumerators(conditionIdBytes32, 0),
			ctf.payoutNumerators(conditionIdBytes32, 1),
		]);

		const winningIndexSets: bigint[] = [];
		if (numerator0.gt(0)) winningIndexSets.push(1n);
		if (numerator1.gt(0)) winningIndexSets.push(2n);

		return winningIndexSets;
	}

	/**
	 * Check if NegRiskAdapter is approved to spend CTF tokens.
	 */
	async isNegRiskAdapterApproved(): Promise<boolean> {
		const ctf = this.getCtfContract();
		const walletAddress = this.getWalletAddress();
		return ctf.isApprovedForAll(
			walletAddress,
			POLYGON_ADDRESSES.NEG_RISK_ADAPTER_ADDRESS,
		);
	}

	/**
	 * Format condition ID as bytes32.
	 */
	private formatConditionId(conditionId: string): string {
		return conditionId.startsWith("0x") ? conditionId : `0x${conditionId}`;
	}

	/**
	 * Redeem resolved positions.
	 * Claims winnings from markets that have been settled.
	 */
	async redeemPositions(params: RedeemParams): Promise<RedeemResult> {
		const { conditionId, tokenId, outcomeIndex, negRisk = false } = params;

		try {
			const conditionIdBytes32 = this.formatConditionId(conditionId);

			// Check token balance if tokenId provided
			let tokenBalance = 0n;
			if (tokenId) {
				tokenBalance = await this.getCTFBalance(tokenId);
				if (tokenBalance === 0n) {
					return {
						success: false,
						error:
							"No CTF tokens to redeem. Balance is 0 — position may have already been redeemed.",
					};
				}
				console.log(`Token balance: ${tokenBalance.toString()}`);
			}

			// Check if market is resolved
			const resolved = await this.isMarketResolved(conditionIdBytes32);
			if (!resolved) {
				return {
					success: false,
					error: "Market has not been resolved yet. Cannot redeem positions.",
				};
			}

			let calldata: string;
			let targetAddress: string;

			if (negRisk) {
				// For negative risk markets, use NegRiskAdapter
				if (tokenBalance === 0n) {
					return {
						success: false,
						error: "No tokens to redeem — tokenId is required for negRisk markets",
					};
				}

				const adapterApproved = await this.isNegRiskAdapterApproved();
				if (!adapterApproved) {
					return {
						success: false,
						error:
							"NegRiskAdapter is not approved to spend CTF tokens. Please run approve_allowances first.",
					};
				}

				let amounts: [bigint, bigint];
				if (outcomeIndex === 0) {
					amounts = [tokenBalance, 0n];
				} else if (outcomeIndex === 1) {
					amounts = [0n, tokenBalance];
				} else {
					amounts = [tokenBalance, 0n];
				}

				console.log(`Redeeming negRisk position:`);
				console.log(`  Condition ID: ${conditionIdBytes32}`);
				console.log(`  Amounts: [${amounts[0]}, ${amounts[1]}]`);

				const negRiskAdapter = this.getNegRiskAdapterContract();
				calldata = negRiskAdapter.interface.encodeFunctionData(
					"redeemPositions",
					[conditionIdBytes32, amounts],
				);
				targetAddress = POLYGON_ADDRESSES.NEG_RISK_ADAPTER_ADDRESS;
			} else {
				// For regular CTF markets
				const winningIndexSets = await this.getWinningIndexSets(conditionIdBytes32);

				if (winningIndexSets.length === 0) {
					return {
						success: false,
						error: "No winning outcomes found for this market.",
					};
				}

				console.log(`Redeeming CTF position:`);
				console.log(`  Condition ID: ${conditionIdBytes32}`);
				console.log(`  Winning index sets: [${winningIndexSets.join(", ")}]`);

				const ctf = this.getCtfContract();
				calldata = ctf.interface.encodeFunctionData("redeemPositions", [
					POLYGON_ADDRESSES.USDC_ADDRESS,
					PARENT_COLLECTION_ID,
					conditionIdBytes32,
					winningIndexSets,
				]);
				targetAddress = POLYGON_ADDRESSES.CTF_ADDRESS;
			}

			const tx = await this.sendTx(targetAddress, calldata);
			console.log(`Transaction submitted: ${tx.hash}`);

			const receipt = await tx.wait(1);

			if (receipt.status === 0) {
				return {
					success: false,
					txHash: tx.hash,
					error: `Transaction reverted on-chain. Position may have already been redeemed.`,
				};
			}

			return {
				success: true,
				txHash: receipt.transactionHash,
			};
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : String(error);
			return {
				success: false,
				error: errorMessage,
			};
		}
	}
}

// Singleton instance
let redemptionInstance: PolymarketRedemption | null = null;

/**
 * Get or create the redemption service instance.
 */
export function getRedemptionInstance(): PolymarketRedemption {
	if (!redemptionInstance) {
		redemptionInstance = new PolymarketRedemption();
	}
	return redemptionInstance;
}

// Lazy proxy facade for easy consumption
export const redemptionApi: PolymarketRedemption = new Proxy(
	{} as PolymarketRedemption,
	{
		get(_target, prop, _receiver) {
			const instance = getRedemptionInstance() as unknown as Record<
				string | symbol,
				unknown
			>;
			const value = instance[prop as keyof PolymarketRedemption] as unknown;
			if (typeof value === "function") {
				return value.bind(instance);
			}
			return value;
		},
	},
);