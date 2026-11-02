# MausClaw

**MausClaw is a standalone agent platform: the MausClaw engine runs the turn, model providers are replaceable adapters, and one capability runtime governs tools, MCP, skills, browser, and computer use.**

> MausClaw is a private development fork built on the open-source OpenMausBot codebase (Apache-2.0). Unlike the upstream app, MausClaw does not require Claude Code, Codex, OpenCode, Hermes, Pi, or Antigravity to run a bot. External CLI/ACP engines are not registered or launched here. Model access is through API providers.

## Architecture

Three layers with one-directional dependencies:

```text
Provider / Model catalog + auth
        │
        ▼
Protocol adapter (chat-completions, Responses, Anthropic Messages, Gemini, …)
        │  provider-neutral events
        ▼
MausClaw Agent Engine — admission, model rounds, tool orchestration, context,
state, retry, recovery, steering, budgets
        │
        ▼
Capability Runtime — mount → validate grant → invoke → close
        │
        ├── MCP servers
        ├── Native tools and stored tool-output reads
        ├── Skills (instruction packages)
        └── Browser / computer / data connectors
```

Rules enforced by the design:

- A driver describes a provider; it does not own an agent loop.
- Adding a provider means adding a catalog and protocol adapter, not another loop.
- Adding a capability means registering a provider in the capability runtime, not changing a driver.
- Tool results are data, never instructions or permission grants.
- A capability whose side effect is uncertain is never replayed automatically.

## What works today

- MausClaw native loop with SQLite run and capability journal.
- Natural cancellation, retry classification, `recovery_required`, steering, and announcement nudge.
- Request-size recovery plus summarization compaction with `agent_compactions` and `run.compacted`.
- Native API paths for OpenAI-compatible, Grok, Groq, Meta, MiniMax, Mistral, and Cerebras drivers, all using the shared agent engine.
- Tool-output shaping: oversized results are capped in the prompt, stored in `agent_tool_outputs`, and read through the run-scoped `tool_output_read` capability under the same grant and validation path as every other capability.
- Multimodal user images and tool-result images, gated by model capability.
- Isolated native-only acceptance fixture with a loopback provider, real MCP tool, approval card, run journal, and no agent CLI on `PATH`.

## Install from source

Requirements: Node.js 24+, pnpm 10.33.0.

```sh
git clone https://github.com/cryptyroot-ux/MausClaw.git
cd MausClaw
pnpm install
pnpm build
```

Run the server or desktop shell:

```sh
pnpm omb
# or
pnpm dev:desktop
```

Then configure an API provider in Settings and create a bot on it.

## Verification

```sh
pnpm typecheck
pnpm lint
pnpm exec vitest run server/agent-runtime
pnpm exec vitest run server/native-only.e2e.test.ts server/openai-tools.e2e.test.ts
pnpm exec vitest run scripts/ci-workflow.test.ts
```

The full repository suite is broader than the native slice; use the commands above as the native-runtime gate.

## Documentation

- [Native runtime research and plan index](docs/superpowers/README.md)
- [Platform independence audit and migration phases](docs/superpowers/specs/2026-10-27-omb-platform-independence-audit.md)
- [External engine research](docs/superpowers/specs/2026-10-27-native-engine-external-research.md)
- [CLI-free acceptance contract](docs/superpowers/specs/2026-10-26-omb-cli-free-acceptance-contract.md)
- [Native agent platform design](docs/superpowers/specs/2026-10-26-omb-native-agent-platform-design.md)

## Status and limits

MausClaw is under active development. The engine boundary and native tool path are implemented; provider protocol coverage, background compaction, evaluation against external benchmarks, subagents, plan artifacts, and broader capability unification remain in progress. See the roadmap and audit documents rather than treating this README as a claim of benchmark superiority.

## Relationship to OpenMausBot

MausClaw is derived from [OpenMausBot](https://github.com/milind-soni/OpenMausBot), which remains the upstream project for the chat app, desktop shells, and provider integrations used here. MausClaw is not maintained by or affiliated with the upstream maintainer.

The upstream Apache-2.0 license and notices remain in effect. Enterprise source in `enterprise/` keeps its own upstream license.

## License

[Apache License 2.0](LICENSE) © 2026 Milind Soni and OpenMausBot contributors; MausClaw modifications © 2026 their respective authors. See [LICENSING.md](LICENSING.md) and [enterprise/LICENSE](enterprise/LICENSE) for details.
