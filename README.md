# Confidential AI Attester — Undercollateralized Loan Demo (CRE)

> Disclaimer: This tutorial represents an educational example to use a Chainlink system, product, or service and is provided to demonstrate how to interact with Chainlink's systems, products, and services to integrate them into your own. This template is provided "AS IS" and "AS AVAILABLE" without warranties of any kind, it has not been audited, and it may be missing key checks or error handling to make the usage of the system, product or service more clear. Do not use the code in this example in a production environment without completing your own audits and application of best practices. Neither Chainlink Labs, the Chainlink Foundation, nor Chainlink node operators are responsible for unintended outputs that are generated due to errors in code.

A local, end-to-end simulation of an **attested, undercollateralized DeFi lending** flow.
A private inference API (the "Chainlink Confidential AI Attester") analyses a borrower's bank
statement **inside a TEE**, decides whether to approve a loan, and POSTs the result to a
callback URL. That callback URL is a **CRE workflow's HTTP-trigger endpoint**: the workflow
parses the LLM decision and the inference response digest, ABI-encodes an attested loan
decision, and writes it on-chain through a Solidity consumer contract (`LoanGate`). Each
inference run is stored separately (keyed by its inference id); a DeFi protocol calls
`LoanGate.canBorrow(borrower)` — which reflects the borrower's **latest** decision — to gate
undercollateralized borrowing.

## Prerequisites

- **CRE CLI** (`cre`) — built and verified with **v1.18.0**.
- **Bun** ≥ 1.2.21 (verified with 1.3.0).
- **Foundry** (`forge`, `cast`) — to compile, deploy, and query `LoanGate`.
- A **funded Ethereum Sepolia wallet** — needed for the on-chain steps (`forge create`,
  `cre ... simulate --broadcast`). Get test ETH at [faucets.chain.link](https://faucets.chain.link).


## Setup

```bash
# 1. Install workflow dependencies + WASM tooling (runs `cre-setup` automatically)
cd undercollateralized-loan-attestation-workflow
bun install
cd ..
```

Then fill in `CRE_ETH_PRIVATE_KEY` and `INFERENCE_API_KEY_VAR` in the `.env` file at the project root:

```bash
# CRE:
###############################################################################
### REQUIRED ENVIRONMENT VARIABLES - SENSITIVE INFORMATION                  ###
### DO NOT STORE RAW SECRETS HERE IN PLAINTEXT IF AVOIDABLE                 ###
### DO NOT UPLOAD OR SHARE THIS FILE UNDER ANY CIRCUMSTANCES                ###
###############################################################################
# Ethereum private key or 1Password reference (e.g. op://vault/item/field)
CRE_ETH_PRIVATE_KEY=<YOUR_PRIVATE_KEY_GOES_HERE>
# Profile to use for this environment (e.g. local-simulation, production-settings, staging-settings) - Do not change for demo.
CRE_TARGET=staging-settings

# Chainlink Confidential AI Attester:
# API key for the inference provider
INFERENCE_API_KEY_VAR=<YOUR_INFERENCE_API_KEY_GOES_HERE>
```

Run `source .env` to load these into your shell environment.

## Scenario 1) Local simulation

> This example uses the `LoanGate.sol` deployed at https://sepolia.etherscan.io/address/0x21937f68a223D6682f4b40517C6358446890Be1F#code and `0x0000000000000000000000000000000000000001` as the borrower address. 

Run from the **project root** (the directory with `project.yaml`):

```bash
cre workflow simulate undercollateralized-loan-attestation-workflow \
  --non-interactive \
  --trigger-index 0 \
  --http-payload ./simulation/callback-payload.json \
  --broadcast
```

Expected log output:

```
✓ Workflow compiled
[USER LOG] Inference callback received: id=019ea31f-... status=completed
[USER LOG] LLM decision: approved=true risk=low confidence=high
[USER LOG] transcriptHash=0x0a0124911560a2236e432d30c3e2a90b0666f4c84b40bf10ba01960595c6ecea documentDigest=32949a93625bf993f9dfce501544e0f1996c744a24fd9b923103a2e081c9157d
[USER LOG] On-chain write: txHash=0xb8b3eb0567f6864c4e90ee668bd4a2d526882214daa1ef180142aa9892711349 error=n/a
✓ Workflow Simulation Result:
"{\"id\":\"019ea31f-...\",\"approved\":true,\"reason\":\"...\",\"transcriptHash\":\"0x0a012491...\",\"documentDigest\":\"32949a93...\",...}"
```

To test using your own `LoanGate` deployment:
- deploy `LoanGate` to Ethereum Sepolia
```bash
forge create contracts/LoanGate.sol:LoanGate --broadcast \
  --rpc-url https://ethereum-sepolia-rpc.publicnode.com \
  --private-key $CRE_ETH_PRIVATE_KEY \
  --constructor-args 0x15fC6ae953E024d975e77382eEeC56A9101f9F88
```
- update `consumerAddress` in `undercollateralized-loan-attestation-workflow/config.staging.json` to point to your deployed address
- and set `borrowerAddress` to a real address you'll query. 

---

## Scenario 2) End-to-end flow

### Prerequisites

This scenario runs the workflow **locally** — no CRE Deploy Access needed. It relies on the local HTTP-trigger server in `cre workflow simulate`. You also need **ngrok** (or cloudflared) to expose the local trigger to the remote Attester.

### Overview

```text
  Borrower / dApp
      │  uploads bank statement; POST /v1/inference with cre_callback = CRE HTTP endpoint
      ▼
  Chainlink Confidential AI Attester   (LLM inside a TEE)
      │  decides approve / decline, signs request & response digests,
      │  POSTs the result to cre_callback
      ▼
  CRE workflow   (undercollateralized-loan-attestation-workflow/main.ts)
      1. HTTP trigger receives the callback body (payload.input bytes)
      2. status !== "completed"  → log + return early
      3. parse output JSON (strip the ```json fence)  → { approved, reason, ... }
      4. transcriptHash = resources[0].response_digest
      5. encodeAbiParameters(address, bool, string, bytes32, string inferenceId)
      6. runtime.report(...)  →  evmClient.writeReport(...)
      7. return JSON summary
      │  signed report, delivered via the KeystoneForwarder
      ▼
  contracts/LoanGate.sol   (onReport, onlyForwarder)
      • abi.decode → (borrower, approved, reason, transcriptHash, inferenceId)
      • decisionsById[keccak256(inferenceId)] = LoanDecision{...}   (one record per run)
      • latestKeyByBorrower[borrower] = key;  emit LoanDecisionRecorded
      ▼
  DeFi protocol calls LoanGate.canBorrow(borrower) → bool   (reflects the latest decision)
```

### 1. Deploy `LoanGate` to Ethereum Sepolia

Use the **MockKeystoneForwarder** as the constructor arg (that's the forwarder `cre ... simulate --broadcast` writes through):

```bash
forge create contracts/LoanGate.sol:LoanGate --broadcast \
  --rpc-url https://ethereum-sepolia-rpc.publicnode.com \
  --private-key $CRE_ETH_PRIVATE_KEY \
  --constructor-args 0x15fC6ae953E024d975e77382eEeC56A9101f9F88
```

Copy the deployed address.

### 2. Point the workflow at it

In `undercollateralized-loan-attestation-workflow/config.staging.json`:
- set `consumerAddress` to the deployed `LoanGate` address, and
- set `borrowerAddress` to a real address you'll query (the decision is keyed to it).

### 3. Start the workflow locally and expose its HTTP trigger

Run `simulate` **without** `--http-payload`. With CRE CLI v1.19.0 or above it starts a local HTTP-trigger server on **port 2000** (path `/trigger`) and waits for the callback, broadcasting the on-chain write when it arrives:

```bash
cre workflow simulate undercollateralized-loan-attestation-workflow --broadcast
```

You should see something like:

```bash
[SIMULATION] Simulator Initialized
[SIMULATION] Running trigger trigger=http-trigger@1.0.0-alpha
Waiting for HTTP request to start execution (listening on http://localhost:2000/trigger)...
```

In a second terminal, expose port 2000 so the remote Attester can reach it:

```bash
ngrok http 2000      # → https://<something>.ngrok-free.dev
```


### 4. Call the Chainlink Confidential AI Attester with the local trigger as the callback

Set the Attester base URL and your `cre_callback` URL — the ngrok tunnel from step 3 with the `/trigger` path appended:

```bash
export BASE_URL="http://localhost:8888"                              # the Chainlink Confidential AI Attester endpoint
export CRE_CALLBACK_URL="https://<something>.ngrok-free.dev/trigger"  # ngrok URL from step 3 + /trigger
```

```bash
PDF_B64=$(base64 -i ./simulation/Bank\ Statement\ —\ First\ Atlantic\ Bank.pdf)
```

```bash
curl -s -X POST $BASE_URL/v1/inference \
  -H "Authorization: Bearer $INFERENCE_API_KEY_VAR" \
  -H "Content-Type: application/json" \
  -d "{
    \"model\": \"gemma4\",
    \"system_prompt\": \"You are a financial compliance analyst. Analyze the provided financial documents and answer questions based strictly on their content. Always respond with a valid JSON object and nothing else.\",
    \"prompt\": \"Based on the financial documents provided, is this individual a suitable candidate for an undercollateralized DeFi loan of 500,000 USDC? Analyze only what is visible in the statement: sum all credit transactions to estimate monthly income, sum all debit transactions to estimate monthly obligations, note total liquid assets as a repayment buffer. Do not decline to answer due to missing documents — assess on available evidence. Respond with ONLY a valid JSON object: {\\\"approved\\\": true, \\\"confidence\\\": \\\"high\\\", \\\"reason\\\": \\\"one sentence citing specific figures from the statement\\\", \\\"estimated_monthly_income_usd\\\": 312500, \\\"estimated_monthly_obligations_usd\\\": 45000, \\\"liquid_buffer_usd\\\": 2106990, \\\"risk_level\\\": \\\"low\\\"}\",
    \"resources\": [{
      \"filename\": \"Bank Statement — First Atlantic Bank.pdf\",
      \"content_type\": \"application/pdf\",
      \"content_base64\": \"$PDF_B64\"
    }],
    \"cre_callback\": { \"url\": \"$CRE_CALLBACK_URL\" }
  }" | jq '{id, status}'
```

You should see:

```json
{
  "id": "019ea785-... (some uuid)",
  "status": "queued"
}
```

The Attester runs the inference in its TEE and POSTs the decision to your `cre_callback` URL — the ngrok tunnel to your locally-running `cre workflow simulate` HTTP-trigger server (port 2000). The workflow parses the callback, encodes the decision, and writes it on-chain through `LoanGate.onReport` — all in one seamless flow from the Attester to Ethereum Sepolia.

> Older `cre cli` versions don't serve the trigger locally. Either update the CLI or fallback to scenario 1)

If successful, you should see in the pending `cre workflow simulate` terminal the logs of the workflow execution, including the on-chain write:

```bash
[USER LOG] Inference callback received: id=019eaded-20f1-7b2d-b2d6-9f52131434e3 status=completed
[USER LOG] LLM decision: approved=true risk=low confidence=high
[USER LOG] transcriptHash=0x0a0124911560a2236e432d30c3e2a90b0666f4c84b40bf10ba01960595c6ecea documentDigest=32949a93625bf993f9dfce501544e0f1996c744a24fd9b923103a2e081c9157d
[USER LOG] On-chain write: txHash=0x804a2639c68aa4ef23f3fc89e0b3b9597683b9f6d02c479ffd3282c9760a8838 error=n/a

✓ Workflow Simulation Result:
"{\"id\":\"019eaded-20f1-7b2d-b2d6-9f52131434e3\",\"status\":\"completed\",\"borrower\":\"0x0000000000000000000000000000000000000001\",\"approved\":true,\"reason\":\"The individual demonstrates significant financial strength with total monthly credits of $312,500.00 and a liquid buffer exceeding $2.1 million.\",\"riskLevel\":\"low\",\"confidence\":\"high\",\"estimatedMonthlyIncomeUsd\":312500,\"estimatedMonthlyObligationsUsd\":47820.33,\"liquidBufferUsd\":2106990.22,\"transcriptHash\":\"0x0a0124911560a2236e432d30c3e2a90b0666f4c84b40bf10ba01960595c6ecea\",\"documentDigest\":\"32949a93625bf993f9dfce501544e0f1996c744a24fd9b923103a2e081c9157d\",\"consumerAddress\":\"0x21937f68a223D6682f4b40517C6358446890Be1F\",\"chainSelectorName\":\"ethereum-testnet-sepolia\",\"write\":{\"attempted\":false}}"
```



### KeystoneForwarder addresses (Ethereum Sepolia)

| Use         | Address                                      |
|-------------|----------------------------------------------|
| Simulation  | `0x15fC6ae953E024d975e77382eEeC56A9101f9F88` (MockKeystoneForwarder, with `--broadcast`) |
| Production  | `0xF8344CFd5c43616a4366C34E3EEE75af79a74482` (KeystoneForwarder) |

Pass the forwarder that matches how you write (`--broadcast` → the mock) to the `LoanGate`
constructor.
