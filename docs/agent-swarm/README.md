# Agent Swarm Skill Pack

This folder contains a portable skill pack for extending another agent swarm with Warp bridge capabilities.

## Files
- WARP_BRIDGE_AGENT_CAPABILITY_SPEC.md: detailed architecture and operating model.
- WARP_BRIDGE_ROUTE_CALL_GRAPH_RUNBOOK.md: deep route-level call graph, handoffs, and validation gates.
- skills/offer-lifecycle/SKILL.md: offer creation/parsing skills (including Sage WalletConnect path).
- skills/chia-contract-drivers/SKILL.md: Chia contract and puzzle orchestration.
- skills/cross-chain-eth-base/SKILL.md: EVM interoperability for Ethereum and Base.
- skills/validator-signature-acceptance/SKILL.md: signature threshold validation and destination acceptance flow.

## Recommended Swarm Integration
1. Load WARP_BRIDGE_AGENT_CAPABILITY_SPEC.md as shared system/context knowledge.
2. Register each SKILL.md as a callable specialty capability.
3. Route tasks by phase:
- Offer generation/parsing -> offer-lifecycle
- Puzzle/spend construction -> chia-contract-drivers
- EVM typed signature checks -> cross-chain-eth-base
- Signature threshold + acceptance sequencing -> validator-signature-acceptance
4. Keep network constants sourced from repository config and not duplicated in prompts.

## Minimal End-To-End Capability Test
1. Create offer through Sage WalletConnect for a Chia -> EVM bridge start.
2. Parse offer and build source spend bundle candidate.
3. Collect and verify validator signatures for destination network threshold.
4. Execute destination acceptance logic and produce tx id/coin id output.
