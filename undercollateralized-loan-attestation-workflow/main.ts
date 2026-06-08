// ============================================================================
// Undercollateralized Loan Attestation Workflow (CRE, TypeScript)
// ============================================================================
// Flow:
//   1. The inference API (the "Chainlink Confidential AI Attester") analyses a
//      borrower's bank statement INSIDE A TEE, decides whether to approve an
//      undercollateralized DeFi loan, and POSTs the result to a callback URL.
//   2. That callback URL is this workflow's HTTP-trigger endpoint. It parses the
//      LLM decision, uses the inference response digest as the transcript hash,
//      ABI-encodes the decision, and writes it on-chain via the EVM client.
//   3. The on-chain LoanGate consumer stores the decision and exposes
//      canBorrow(address) so a DeFi protocol can gate borrowing.
//
// This workflow reads ONLY fields present in simulation/callback-payload.json.
// QuickJS/WASM runtime: no process.env / Buffer / crypto; viem does all ABI
// encoding and hashing; Solidity integers are bigint.
// ============================================================================

import {
	EVMClient,
	HTTPCapability,
	handler,
	prepareReportRequest,
	Runner,
	type HTTPPayload,
	type Runtime,
} from "@chainlink/cre-sdk";
import {
	bytesToString,
	encodeAbiParameters,
	getAddress,
	parseAbiParameters,
	sha256,
	stringToHex,
	toHex,
	type Hex,
} from "viem";

// --- Config (config.staging.json / config.production.json) ------------------

// HTTP trigger authorized signer key. Leave authorizedKeys empty ([]) in
// simulation to accept any sender.
type AuthorizedKey = {
	type?: "KEY_TYPE_UNSPECIFIED" | "KEY_TYPE_ECDSA_EVM";
	publicKey?: string;
};

export type Config = {
	authorizedKeys: AuthorizedKey[];
	consumerAddress: `0x${string}`;
	chainSelectorName: string;
	borrowerAddress: `0x${string}`;
};

// --- Inference-API callback (only the fields this workflow uses) ------------
// See simulation/callback-payload.json.
type InferenceCallback = {
	id?: string;
	status?: string; // "completed" | "failed"
	output?: string; // LLM decision as JSON, wrapped in a ```json fence
	resource_summaries?: { digest?: string; filename?: string }[];
	resources?: { digest?: string; request_digest?: string; response_digest?: string }[];
};

// The JSON the LLM is asked to return in the prompt we provide.
// See simulation/prompt.txt.
type LlmDecision = {
	approved?: boolean;
	confidence?: string;
	reason?: string;
	estimated_monthly_income_usd?: number;
	estimated_monthly_obligations_usd?: number;
	liquid_buffer_usd?: number;
	risk_level?: string;
};

// ABI shape written on-chain and decoded by LoanGate.onReport():
//   (address borrower, bool approved, string reason, bytes32 transcriptHash, string inferenceId)
const LOAN_DECISION_ABI =
	"address borrower, bool approved, string reason, bytes32 transcriptHash, string inferenceId";

// --- Helpers ----------------------------------------------------------------

/** The LLM output is JSON wrapped in a ```json … ``` fence; strip it and parse. */
const parseLlmDecision = (output: string): LlmDecision => {
	const fenced = output.trim().match(/^```(?:[a-zA-Z0-9]+)?\s*([\s\S]*?)\s*```$/);
	return JSON.parse(fenced ? fenced[1].trim() : output) as LlmDecision;
};

/** Normalize a 32-byte hex digest (with or without 0x) to a bytes32 value. */
const toBytes32 = (hex: string): Hex => {
	const h = hex.replace(/^0[xX]/, "");
	if (h.length !== 64 || !/^[0-9a-fA-F]+$/.test(h)) {
		throw new Error(`expected a 32-byte hex digest, got "${hex}"`);
	}
	return `0x${h.toLowerCase()}` as Hex;
};


// --- HTTP trigger handler — receives the inference-API callback -------------

export const onInferenceCallback = (runtime: Runtime<Config>, payload: HTTPPayload): string => {
	// 1. Decode the HTTP body bytes into the callback object.
	const callback = JSON.parse(bytesToString(payload.input)) as InferenceCallback;
	runtime.log(
		`Inference callback received: id=${callback.id ?? "unknown"} status=${callback.status ?? "unknown"}`,
	);

	// 2. Only act on completed inferences.
	if (callback.status !== "completed") {
		runtime.log(`Status is not "completed"; skipping on-chain write.`);
		return JSON.stringify({
			id: callback.id ?? null,
			status: callback.status ?? null,
			action: "skipped",
		});
	}

	// 3. Parse the LLM decision from the fenced output JSON.
	const decision = parseLlmDecision(callback.output ?? "");
	const approved = decision.approved === true;
	const reason = decision.reason ?? "";
	runtime.log(
		`LLM decision: approved=${approved} risk=${decision.risk_level ?? "n/a"} confidence=${
			decision.confidence ?? "n/a"
		}`,
	);

	// 4. Use the inference response digest as the on-chain transcript hash
	//    (fall back to hashing the raw output if no response digest is present).
	const responseDigest = callback.resources?.[0]?.response_digest;
	const transcriptHash = responseDigest
		? toBytes32(responseDigest)
		: sha256(stringToHex(callback.output ?? ""));
	const documentDigest =
		callback.resources?.[0]?.digest ?? callback.resource_summaries?.[0]?.digest ?? "n/a";
	runtime.log(`transcriptHash=${transcriptHash} documentDigest=${documentDigest}`);

	// 5. ABI-encode the loan decision: (address, bool, string, bytes32, string).
	const borrower = getAddress(runtime.config.borrowerAddress);
	const inferenceId = callback.id ?? "";
	const encodedPayload = encodeAbiParameters(parseAbiParameters(LOAN_DECISION_ABI), [
		borrower,
		approved,
		reason,
		transcriptHash,
		inferenceId,
	]);

	// 6. Generate a signed report and write it on-chain. Guarded so the workflow
	//    always returns a summary even when the write can't be broadcast.
	let write: Record<string, unknown> = { attempted: false };
	try {
		const signedReport = runtime.report(prepareReportRequest(encodedPayload)).result();

		const selectors = EVMClient.SUPPORTED_CHAIN_SELECTORS;
		const chainSelector = selectors[runtime.config.chainSelectorName as keyof typeof selectors];
		if (chainSelector === undefined) {
			throw new Error(`unsupported chainSelectorName: ${runtime.config.chainSelectorName}`);
		}

		const reply = new EVMClient(chainSelector)
			.writeReport(runtime, {
				receiver: runtime.config.consumerAddress,
				report: signedReport,
				gasConfig: { gasLimit: "500000" },
			})
			.result();

		const txHash = reply.txHash ? toHex(reply.txHash) : null;
		const errorMessage = reply.errorMessage ?? null;
		runtime.log(`On-chain write: txHash=${txHash ?? "n/a"} error=${errorMessage ?? "n/a"}`);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		write = { attempted: true, error: message };
		runtime.log(
			`On-chain write failed (expected in simulation without --broadcast / a real consumer): ${message}`,
		);
	}

	// 7. Return a JSON summary.
	return JSON.stringify({
		id: callback.id ?? null,
		status: callback.status,
		borrower,
		approved,
		reason,
		riskLevel: decision.risk_level ?? null,
		confidence: decision.confidence ?? null,
		estimatedMonthlyIncomeUsd: decision.estimated_monthly_income_usd ?? null,
		estimatedMonthlyObligationsUsd: decision.estimated_monthly_obligations_usd ?? null,
		liquidBufferUsd: decision.liquid_buffer_usd ?? null,
		transcriptHash,
		documentDigest,
		consumerAddress: runtime.config.consumerAddress,
		chainSelectorName: runtime.config.chainSelectorName,
		write,
	});
};

// --- Workflow wiring --------------------------------------------------------

export const initWorkflow = (config: Config) => {
	const http = new HTTPCapability();
	return [handler(http.trigger({ authorizedKeys: config.authorizedKeys }), onInferenceCallback)];
};

export async function main() {
	const runner = await Runner.newRunner<Config>();
	await runner.run(initWorkflow);
}
