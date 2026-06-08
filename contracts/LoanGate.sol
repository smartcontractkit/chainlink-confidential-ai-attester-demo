// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

// ============================================================================
// LoanGate — on-chain gate for an attested, undercollateralized DeFi loan
// ============================================================================
//
// Full flow:
//
//   ┌──────────────────────────┐   POST /v1/inference           ┌────────────────┐
//   │  Borrower / dApp         │ ────────────────────────────▶  │ Inference      │
//   │  (uploads bank statement)│                                │   API          │
//   └──────────────────────────┘                                │ ("Chainlink    │
//                                                               │  Confidential  │
//                                                               │  AI Attester", │
//   The inference API runs an LLM INSIDE A TEE, decides whether │  in TEE)       │
//   to approve the loan, and POSTs the result to a callback URL └─────┬──────────┘
//   ( = a CRE HTTP-trigger endpoint).                                 │
//                                                                     │ callback
//                                                                     ▼
//   ┌──────────────────────────────────────────────────────────────────────┐
//   │ CRE workflow (undercollateralized-loan-attestation-workflow/main.ts) │
//   │  • parses the LLM decision + attestation provenance                  │
//   │  • ABI-encodes (address borrower, bool approved, string reason,      │
//   │                 bytes32 transcriptHash)                              │
//   │  • runtime.report(...) then evmClient.writeReport(...)               │
//   └───────────────────────────────┬──────────────────────────────────────┘
//                                   │ report (via KeystoneForwarder)
//                                   ▼
//   ┌──────────────────────────────────────────────────────────────────────┐
//   │ LoanGate.onReport(metadata, report)  ── THIS CONTRACT                │
//   │  • only the trusted forwarder may call                               │
//   │  • decodes + stores the decision keyed by borrower                   │
//   │  • DeFi protocol calls canBorrow(borrower) to gate borrowing         │
//   └──────────────────────────────────────────────────────────────────────┘
//
// Deployment note — pass the correct KeystoneForwarder for the target to the
// constructor:
//   • Simulation (Ethereum Sepolia, used with `cre ... simulate --broadcast`):
//       0x15fC6ae953E024d975e77382eEeC56A9101f9F88   (MockKeystoneForwarder)
//   • Production (Ethereum Sepolia):
//       0xF8344CFd5c43616a4366C34E3EEE75af79a74482   (KeystoneForwarder)
//
// Minimal + dependency-free by design: the forwarder check is inlined rather
// than pulling in OpenZeppelin. (A production receiver may additionally expose
// ERC-165 `supportsInterface` so the forwarder can detect IReceiver support.)
// ============================================================================

/// @notice Minimal CRE receiver interface. The KeystoneForwarder calls
///         `onReport` with workflow metadata and the ABI-encoded report.
interface IReceiver {
    function onReport(bytes calldata metadata, bytes calldata report) external;
}

contract LoanGate is IReceiver {
    /// @notice Stored loan decision for a single inference run.
    struct LoanDecision {
        string inferenceId; // inference-API request id (unique per run)
        address borrower;
        bool approved;
        string reason;
        bytes32 transcriptHash; // SHA-256 digest of the inference transcript
        uint256 timestamp; // block time the decision was recorded
    }

    /// @notice The only address allowed to deliver reports to this contract.
    address public immutable forwarder;

    /// @notice keccak256(inferenceId) => the decision recorded for that run.
    mapping(bytes32 => LoanDecision) public decisionsById;

    /// @notice borrower => key of their most recent decision.
    mapping(address => bytes32) public latestKeyByBorrower;

    event LoanDecisionRecorded(
        bytes32 indexed inferenceIdHash, address indexed borrower, bool approved, bytes32 transcriptHash
    );

    error UnauthorizedForwarder(address caller);

    modifier onlyForwarder() {
        if (msg.sender != forwarder) {
            revert UnauthorizedForwarder(msg.sender);
        }
        _;
    }

    constructor(address forwarder_) {
        forwarder = forwarder_;
    }

    /// @inheritdoc IReceiver
    /// @dev `metadata` (workflow id / DON id) is unused in this minimal demo.
    ///      The decoded tuple must match the workflow's encodeAbiParameters call.
    function onReport(bytes calldata, bytes calldata report) external onlyForwarder {
        (address borrower, bool approved, string memory reason, bytes32 transcriptHash, string memory inferenceId) =
            abi.decode(report, (address, bool, string, bytes32, string));

        bytes32 key = keccak256(bytes(inferenceId));
        decisionsById[key] = LoanDecision({
            inferenceId: inferenceId,
            borrower: borrower,
            approved: approved,
            reason: reason,
            transcriptHash: transcriptHash,
            timestamp: block.timestamp
        });
        latestKeyByBorrower[borrower] = key;

        emit LoanDecisionRecorded(key, borrower, approved, transcriptHash);
    }

    /// @notice Returns true if the borrower's MOST RECENT decision is approved.
    ///         A DeFi lending protocol calls this to gate undercollateralized borrowing.
    function canBorrow(address borrower) external view returns (bool) {
        return decisionsById[latestKeyByBorrower[borrower]].approved;
    }

    /// @notice The borrower's most recent attested decision.
    function latestDecision(address borrower) external view returns (LoanDecision memory) {
        return decisionsById[latestKeyByBorrower[borrower]];
    }

    /// @notice Look up a specific inference run by its request id.
    function getDecisionById(string calldata inferenceId) external view returns (LoanDecision memory) {
        return decisionsById[keccak256(bytes(inferenceId))];
    }
}
