# DSH External Agent Wrappers on GitHub

English | [中文](github-subagent-harness-landscape-2026-08-16.zh.md)

Date: 2026-08-16

## Question

Has anyone packaged DeepSeek Harness (DSH) so another agent tool can launch it directly as a subagent, ACP agent, or uniform CLI?

## Conclusion

Several projects address this problem, and community implementations primarily converge on ACP instead of wrapping the plain-text stdout of `dsh --profile headless`. No consensus upstream `dsh subagent` CLI was found, but multiple installable third-party wrappers and profile bundles provide the missing installation, configuration, credentials, editor registration, and ACP capability layer.

This research used static checks of primary GitHub sources only. The external projects were not installed or executed, and their current npm releases were not compared exhaustively with repository source.

## Directly relevant implementations

### `asteroida123/dsh-codeg-adapter`

This is the closest implementation to a thin wrapper. Its README states that it does not implement ACP itself; it packages the official `@deepseek-ai/dsh-acp` and `@deepseek-ai/dsh-acp-demo` packages behind an installable `dsh-codeg` command. It pins a DSH release candidate, reads `DEEPSEEK_API_KEY` from the environment or `.env`, passes its bundled `cordis.yml` by absolute path, and provides Codeg registration. `bin/dsh-codeg.js` spawns Node with `@deepseek-ai/dsh-acp-demo/bin` and the bundled configuration.

- README: https://github.com/asteroida123/dsh-codeg-adapter/blob/main/README.md
- package metadata: https://github.com/asteroida123/dsh-codeg-adapter/blob/main/package.json
- launcher: https://github.com/asteroida123/dsh-codeg-adapter/blob/main/bin/dsh-codeg.js

Assessment: it turns the manual installation of multiple DSH packages and configuration into an entry point for one external agent client, while still relying on the official automation-only ACP capability.

### `devloom1024/dsh-acp-gateway`

This is a more complete third-party ACP product wrapper. Its README provides a one-command `npx -y dsh-acp-gateway` launch, Zed and VS Code ACP configuration, standalone and offline archive distributions, an ACP registry JSON entry, and sessions, streaming, tool calls, agent presets, model selection, and permission controls. `package.json` declares the executable, while `src/index.ts` exposes a Cordis plugin and implements ACP request handling, session management, notifications, and bridge-script generation.

- README: https://github.com/devloom1024/dsh-acp-gateway/blob/main/README.md
- package metadata: https://github.com/devloom1024/dsh-acp-gateway/blob/main/package.json
- gateway source: https://github.com/devloom1024/dsh-acp-gateway/blob/main/src/index.ts
- registry entry: https://github.com/devloom1024/dsh-acp-gateway/blob/main/registry.json

Assessment: it integrates the DSH runtime, ACP server, distribution entry point, and editor registration into one product form. It remains an independent third-party implementation and does not indicate upstream adoption.

### `cnctem/dsh-acp`

This project follows the profile-bundle route. Its README installs the package with `dsh plugin --profile acp add github:cnctem/dsh-acp` and configures Zed to launch `dsh --profile acp`. The project states that it builds on the official ACP skeleton and adds token and thinking streaming, tool cards, session history, model and thinking selectors, presets, terminal support, usage, and elicitation.

- README: https://github.com/cnctem/dsh-acp/blob/main/README.md
- package metadata: https://github.com/cnctem/dsh-acp/blob/main/package.json

Assessment: it reuses DSH's profile and plugin distribution mechanism, matching the approach of adding an installable profile and client entry point over existing lower-level capabilities.

### `grunmin/dsh-acp-enhanced`

This is another profile and plugin implementation. Its README describes it as a drop-in replacement for the official `@deepseek-ai/dsh-acp` package and provides `dsh plugin --profile acp-enhanced add dsh-acp-enhanced`, a Zed launcher, streaming, telemetry, model and permission controls, session management, MCP, and plans. `package.json` declares `dsh.bundle.patch`, showing that it installs through the DSH bundle convention.

- README: https://github.com/grunmin/dsh-acp-enhanced/blob/main/README.md
- package metadata: https://github.com/grunmin/dsh-acp-enhanced/blob/main/package.json

Assessment: it targets the same problem as the preceding project, focusing on extending automation-only ACP into an editor-facing experience.

### `xintaofei/deepseek-acp`

This project provides an independent `deepseek-acp` ACP executable. Its README distinguishes the official automation-only bridge from its full editor-facing agent and provides `npx deepseek-acp`, `npm i -g deepseek-acp`, Zed, and Codeg registration. It claims token streaming, tool cards, diffs, terminals, plans, session load and list operations, model and permission selectors, MCP, and usage reporting.

- README: https://github.com/xintaofei/deepseek-acp/blob/main/README.md

Assessment: it follows the route of packaging DSH as a standalone agent binary that ACP editors can launch directly. Its npm package and complete test suite were not executed during this research.

### `zhiyuchen1101/codewhale-dsh`

This is a reverse-bridge example. CodeWhale exposes `dsh_init`, `dsh_status`, `dsh_read`, `dsh_cancel`, and `dsh_respond` through MCP, starts DSH headless in the background, and lists integration with official ACP streaming on its roadmap. It is not a general DSH CLI, but a worker bridge for one external agent.

- README: https://github.com/zhiyuchen1101/codewhale-dsh/blob/main/README.md

Assessment: it demonstrates that an external agent can call DSH headless through a protocol bridge, but the API is specific to CodeWhale rather than a general subagent interface.

## Excluded projects

GitHub search also returned many DSH plugins, monitoring dashboards, user interfaces, agent presets, and subagent providers. Those projects improve capabilities inside DSH but do not expose an ACP, JSON-RPC, or CLI entry point that another agent can launch directly, so they are outside this research question.

## Implications for this repository

The external implementations support the assessment that the lower-level capabilities exist while the product wrapper remains incomplete:

1. The smallest wrapper is an npm or npx launcher that owns dependencies, versions, credentials, absolute configuration paths, and client registration.
2. A fuller wrapper is an installable profile or bundle that exposes `dsh --profile acp` and owns the streaming, tool calls, session management, permissions, and mode selection expected by editors.
3. The community primarily chooses ACP because it is a better cross-agent and IDE process protocol than headless stdout. A plain CLI remains suitable for one-shot workers but does not provide a complete subagent transport.
4. Most projects found are recent, have few stars, or are independent third-party implementations. They do not yet constitute a mature ecosystem standard; upstream acceptance, maintenance, or integration requires separate confirmation.

## Search and evidence limits

The initial GitHub repository searches used queries including `deepseek-harness subagent`, `dsh DeepSeek agent`, and `DeepSeek ACP agent`. Candidate GitHub READMEs, `package.json` files, launchers, plugin sources, and registry files were then inspected individually. The GitHub API reached its unauthenticated rate limit during later queries, so the API results were not treated as exhaustive statistics. This report includes only primary repository sources that were opened and checked.
