# Qirei PRDs

The build of Qirei is split into 32 PRDs over five lanes, one lane per Claude Code session. Each PRD is self-contained:
one session can build it without asking another. The design behind this split is
[docs/superpowers/specs/2026-11-19-qirei-build-plan-design.md](../superpowers/specs/2026-11-19-qirei-build-plan-design.md);
the product is described in [FEATURE.md](../../FEATURE.md), the system in [ARCHITECTURE.md](../../ARCHITECTURE.md) and the
look in [UI_DESIGN_GUIDE.md](../../UI_DESIGN_GUIDE.md).

## Lanes

| Session | Lane | Folder | Builds GPUI | Worktree |
|---|---|---|---|---|
| S1 | foundation (lead) | `foundation/` | only at merge windows, through `~/.cache/qirei/gpui/target` | the main checkout |
| S2 | agent-runtime | `agent-runtime/` | no | `../qirei-s2`, branch `lane/agent-runtime` |
| S3 | integrations | `integrations/` | no | `../qirei-s3`, branch `lane/integrations` |
| S4 | terminal-data | `terminal-data/` | no | `../qirei-s4`, branch `lane/terminal-data` |
| S5 | ui | `ui/` | yes, the only lane | `../qirei-s5`, branch `lane/ui` |

## How a session starts

1. Read `<lane>/SESSION.md`: environment, rules, and the order of the lane's PRDs.
2. Build the lane's PRDs in number order. Before F01 (the workspace) is merged, read the PRDs and run the lane's spike in
   `spikes/<name>/`, which has its own `[workspace]` and needs no shared crate.
3. The PRDs are the approved design: no brainstorming, no new design approval. Work test first, in the session itself
   (no parallel subagent teams: the Mac has 16 GB of RAM).
4. Edit only the files your PRD owns. A change to a shared contract goes to the lead through `coord/requests.md`.
5. When a PRD is done and its tests pass: mark it `ready` in `coord/board.md`, write `coord/handoff/<lane>.md`, tell the
   lead, start the next PRD. The lead merges; lanes never merge or push.

## The PRD format

Front matter, flow-style lists only, so the checker needs no YAML library:

```
---
id: A01
lane: agent-runtime
session: S2
title: Permission rules and approval policy
tier: A
block: D1-morning
depends_on: [F02]
owns: [crates/core/src/permissions/**, crates/core/src/approval.rs]
seeds: []
features: ["Aturan izin (diputuskan di Rust, bukan di sidecar)", "10.7 Keamanan"]
architecture: ["Permissions and grants", "Approval policy (owner decision, 2026-11-19)"]
checkpoint: none
---
```

- `features`: exact FEATURE.md heading texts (without `#`). `architecture`: exact ARCHITECTURE.md heading texts.
- `seeds`: files a foundation PRD creates as stubs that a lane PRD then owns. Only foundation PRDs may have seeds.
- `checkpoint`: `none`, `1` (real agent run, end of D2), `2` (GitLab and Lark, midday D3) or `3` (walk-through, end D3).

Body sections, in this order, all required: `## Goal`, `## Scope` (in and out), `## Contracts` (consumed and provided,
with exact type and route names), `## Requirements` (numbered; every limit, default and fixed text copied from
ARCHITECTURE.md with its value), `## Tests` (named tests; every limit tested at the limit and one over), `## Done when`
(commands and their passing output).

The checker `python3 -I scripts/prd-check.py [--lane <lane>]` enforces the format, unique ownership, dependencies,
coverage of FEATURE.md and the cited ARCHITECTURE.md headings. Its tests are `bash scripts/tests/prd-check-test.sh`.

## The PRD set

| ID | File | Session | Block | Tier | Depends on | Owns | Seeds | Features | Architecture | Checkpoint |
|---|---|---|---|---|---|---|---|---|---|---|
| F01 | `foundation/01-workspace-tooling.md` | S1 | D1-morning | C | – | `Cargo.toml`, `.cargo/**`, `rust-toolchain.toml`, `clippy.toml`, `crates/*/Cargo.toml`, `scripts/check.sh`, `scripts/check-fast.sh`, `scripts/disk-sweep.sh`, `scripts/platform-boundary.sh`, `scripts/gpui-boundary.sh`, `scripts/dev.sh` | – | "Lampiran B: profil development dan production" | "Crates", "Upgrading GPUI", "Testing" | none |
| F02 | `foundation/02-contracts.md` | S1 | D1-morning | B | F01 | `crates/api-types/src/lib.rs`, `crates/api-types/src/events.rs`, `crates/api-types/src/errors.rs` | `crates/api-types/src/{session,settings,inbox,lark,bot,git,documents,source_control,terminal,readpath,dashboard}.rs`, `crates/runtimes/src/protocol.rs` | "1. Peta menu sidebar", "Arsitektur singkat" | "API", "Agent runtime (Claude)" | none |
| F03 | `foundation/03-store.md` | S1 | D1-morning | B | F01 | `crates/store/src/lib.rs`, `crates/store/src/events.rs`, `crates/store/migrations/00*` | `crates/store/src/{runs,settings,inbox,lark,bot,tickets}.rs` | – | "Storage and files", "API" | none |
| F04 | `foundation/04-skeleton.md` | S1 | D1-morning | B | F02, F03 | `crates/engine/src/lib.rs`, `crates/engine/src/engine.rs`, `crates/api/src/lib.rs`, `crates/api/src/router.rs`, `crates/client/src/lib.rs`, `crates/client/src/events.rs`, `crates/core/src/lib.rs`, `crates/app-core/src/lib.rs` | `crates/core/src/{permissions,sandbox,agent_settings,inbox,git_push,lark,bot,source_control,terminal,terminal_send,readpath,tickets}/mod.rs`, `crates/core/src/{approval,frontmatter}.rs`, `crates/engine/src/{policy,credential,runs,settings,gitlab,git,lark,documents,lark_bot,source_control,terminal,terminal_send,readpath,tickets}/mod.rs`, `crates/api/src/routes/{credential,sessions,runs,decisions,settings,inbox,git,lark,documents,bot,source_control,terminal,terminal_send,readpath,dashboard}.rs`, `crates/client/src/{session,settings,inbox,git,lark,documents,bot,source_control,terminal,readpath,dashboard}.rs`, `crates/app-core/src/{session,settings,inbox_gitlab,inbox_lark,documents,bot,source_control,terminal,dashboard,shell}/mod.rs`, `crates/ui-kit/src/lib.rs`, `crates/app/src/main.rs` | – | "Crates", "API" | none |
| F05 | `foundation/05-daemon.md` | S1 | D1-afternoon | A | F04 | `crates/daemon/src/{main,lib,launchd,lock,shutdown}.rs`, `crates/daemon/src/config/mod.rs`, `crates/daemon/src/config/dev.rs`, `crates/local/**` | `crates/daemon/src/config/{agent,git,gitlab,lark,terminal,readpath}.rs` | "Lampiran B: profil development dan production" | "Why a daemon", "Processes", "System locations and how to override them", "Development and production", "Towards other platforms" | none |
| F06 | `foundation/06-web-readiness.md` | S1 | D2-morning | A | F05 | `crates/api/src/web/**`, `crates/daemon/src/config/web.rs` | – | – | "API", "Web readiness" (added by Task 1) | none |
| F07 | `foundation/07-e2e-harness.md` | S1 | D2-morning | B | F05 | `crates/e2e/**`, `scripts/e2e-real.sh` | – | – | "Testing" | 1 |
| A01 | `agent-runtime/01-permission-rules.md` | S2 | D1-morning | A | F01 | `crates/core/src/permissions/**`, `crates/core/src/approval.rs` | – | "Aturan izin (diputuskan di Rust, bukan di sidecar)", "10.7 Keamanan" | "Permissions and grants", "Approval policy (owner decision, 2026-11-19)", "Engine must provide" | none |
| A02 | `agent-runtime/02-sandbox.md` | S2 | D1-afternoon | A | A01, F05 | `crates/core/src/sandbox/**`, `crates/runtimes/src/sandbox.rs`, `crates/engine/src/policy/**` | – | "Sandbox" | "OS sandbox", "Per-run sandbox policy" | none |
| A03 | `agent-runtime/03-sidecar-launch.md` | S2 | D1-afternoon | A | A02, F02 | `crates/runtimes/src/{lib,process,runtime}.rs`, `crates/runtimes/src/protocol.rs`, `crates/runtimes/bindings/**`, `sidecars/claude/**` | – | – | "Agent runtime (Claude)", "Daemon wiring" | none |
| A04 | `agent-runtime/04-credential.md` | S2 | D2-morning | A | A03 | `crates/engine/src/credential/**`, `crates/api/src/routes/credential.rs`, `crates/daemon/src/agent.rs`, `crates/daemon/src/config/agent.rs` | – | "Izin sementara dan kredensial", "10.2 Koneksi" | "Credential control", "Credential gate (engine)" | 1 |
| A05 | `agent-runtime/05-runs-decisions.md` | S2 | D2-afternoon | A | A04 | `crates/engine/src/runs/**`, `crates/api/src/routes/{sessions,runs,decisions}.rs`, `crates/api-types/src/session.rs`, `crates/client/src/session.rs`, `crates/app-core/src/session/**`, `crates/store/src/runs.rs`, `crates/store/migrations/01[0-4]*` | – | "6. Session", "Daftar sesi di sidebar", "Jenis sesi", "Status bar (selalu ada di bawah tab)", "Tab Percakapan (Conversation)", "Composer", "Tab Aktivitas (Activity)" | "Session screen", "Known follow-ups" | 1 |
| A06 | `agent-runtime/06-agent-settings.md` | S2 | D3-morning | A | A05 | `crates/core/src/agent_settings/**`, `crates/core/src/frontmatter.rs`, `crates/engine/src/settings/**`, `crates/api/src/routes/settings.rs`, `crates/api-types/src/settings.rs`, `crates/client/src/settings.rs`, `crates/app-core/src/settings/**`, `crates/store/src/settings.rs`, `crates/store/migrations/01[5-9]*` | – | "10.4 Agent", "10.5 Skills", "10.6 Connectors", "Skill, subagent, connector, kredensial", "Hal yang belum terbukti" | "Agent settings", "Skills in a run", "Settings API", "Subagents", "Connectors", "Settings screen" | 3 |
| I01 | `integrations/01-gitlab-inbox.md` | S3 | D2-morning | A | F05, A05 | `crates/core/src/inbox/**`, `crates/engine/src/gitlab/**`, `crates/api/src/routes/inbox.rs`, `crates/api-types/src/inbox.rs`, `crates/client/src/inbox.rs`, `crates/app-core/src/inbox_gitlab/**`, `crates/daemon/src/config/gitlab.rs`, `crates/store/src/inbox.rs`, `crates/store/migrations/020*` | – | "4. Inbox › GitLab", "5. Inbox › Tambah koneksi" | "GitLab inbox API", "Inbox: GitLab", "Decisions and what is not verified" | 2 |
| I02 | `integrations/02-git-push-mr.md` | S3 | D1-morning (the pure `core` rules) and D1-afternoon (engine) | A | F04 | `crates/core/src/git_push/**`, `crates/engine/src/git/**`, `crates/api/src/routes/git.rs`, `crates/api-types/src/git.rs`, `crates/client/src/git.rs`, `crates/daemon/src/config/git.rs` | – | "Push gate" | "Git, files, documents", "Push gate", "Push action", "Approval policy (owner decision, 2026-11-19)" | 2 |
| I03 | `integrations/03-lark-inbox.md` | S3 | D2-afternoon | A | I01 | `crates/core/src/lark/**`, `crates/engine/src/lark/**`, `crates/api/src/routes/lark.rs`, `crates/api-types/src/lark.rs`, `crates/client/src/lark.rs`, `crates/app-core/src/inbox_lark/**`, `crates/daemon/src/config/lark.rs`, `crates/store/src/lark.rs`, `crates/store/migrations/021*` | – | "3. Inbox › Lark" | "Lark inbox API" | 2 |
| I04 | `integrations/04-documents.md` | S3 | D2-afternoon | A | A05 | `crates/engine/src/documents/**`, `crates/api/src/routes/documents.rs`, `crates/api-types/src/documents.rs`, `crates/client/src/documents.rs`, `crates/app-core/src/documents/**` | – | "Tab Dokumen (Documents)" | "Documents" | 1 |
| I05 | `integrations/05-lark-bot.md` | S3 | D3-morning | A | I03, A05 | `crates/core/src/bot/**`, `crates/engine/src/lark_bot/**`, `crates/api/src/routes/bot.rs`, `crates/api-types/src/bot.rs`, `crates/client/src/bot.rs`, `crates/app-core/src/bot/**`, `crates/store/src/bot.rs`, `crates/store/migrations/022*` | – | "Bot Lark", "9. Status Bot Lark (footer sidebar)" | "Lark bot", "Lark bot: the event stream and the two writes", "Lark bot: the flow and the reply gate", "Lark bot API", "Approval policy (owner decision, 2026-11-19)" | 2 |
| I06 | `integrations/06-source-control.md` | S3 | D3-afternoon | A | I02 | `crates/core/src/source_control/**`, `crates/engine/src/source_control/**`, `crates/api/src/routes/source_control.rs`, `crates/api-types/src/source_control.rs`, `crates/client/src/source_control.rs`, `crates/app-core/src/source_control/**` | – | "7. Source control" | "Git, files, documents" | 3 |
| T01 | `terminal-data/01-terminal-vt.md` | S4 | D1-morning | B | F01 | `crates/terminal-vt/**` | – | "8. Terminal" | "Terminal", "Terminal shells (engine, plan 12)" | none |
| T02 | `terminal-data/02-terminal-engine-api.md` | S4 | D1-afternoon | A | T01, F04 | `crates/core/src/terminal/**`, `crates/engine/src/terminal/**`, `crates/api/src/routes/terminal.rs`, `crates/api-types/src/terminal.rs`, `crates/client/src/terminal.rs`, `crates/app-core/src/terminal/**`, `crates/daemon/src/config/terminal.rs` | – | "8. Terminal", "10.8 Rincian pengaturan terminal (bagian dari Umum; rincian dari arsitektur)" | "Terminal API (plan 12, task 4)", "Split panes and the Terminal settings page (plan 12c part 2)", "Terminal shells (engine, plan 12)" | 1 |
| T03 | `terminal-data/03-send-to-session.md` | S4 | D2-afternoon | A | T02, A05 | `crates/core/src/terminal_send/**`, `crates/engine/src/terminal_send/**`, `crates/api/src/routes/terminal_send.rs` | – | "8. Terminal" | "Send to session (plan 12b)" | 2 |
| T04 | `terminal-data/04-read-path.md` | S4 | D2-morning | A | F04, A01 | `crates/core/src/readpath/**`, `crates/engine/src/readpath/**`, `crates/api/src/routes/readpath.rs`, `crates/api-types/src/readpath.rs`, `crates/client/src/readpath.rs`, `crates/daemon/src/config/readpath.rs` | – | "Jalur baca database (Read path)" | "Read path", "Design", "Configuration", "Limits", "Audit event", "Pipe protocol", "The role probe", "The allow-list rule", "Honest limits" | 3 |
| T05 | `terminal-data/05-dashboard-tickets.md` | S4 | D3-morning | B | A05 | `crates/engine/src/tickets/**`, `crates/core/src/tickets/**`, `crates/api/src/routes/dashboard.rs`, `crates/api-types/src/dashboard.rs`, `crates/client/src/dashboard.rs`, `crates/app-core/src/dashboard/**`, `crates/store/src/tickets.rs`, `crates/store/migrations/03*` | – | "2. Dashboard", "Header sesi tiket", "Panel kanan", "State run tersimpan di folder tiket", "10.3 Tiket" | "Agent runtime (Claude)", "Storage and files" | 3 |
| U01 | `ui/01-tokens-components.md` | S5 | D1-morning | C | F01 | `crates/ui-kit/src/lib.rs`, `crates/ui-kit/src/theme/**`, `crates/ui-kit/src/components/**`, `crates/ui-kit/examples/**`, `crates/ui-kit/tests/**` | – | – | "Upgrading GPUI" | none |
| U02 | `ui/02-window-shell.md` | S5 | D1-afternoon | C | U01, F04 | `crates/ui-kit/src/window/**`, `crates/app/src/{main,shell,sidebar}.rs`, `crates/app-core/src/shell/**` | – | "1. Peta menu sidebar", "10.1 Umum" | "Session screen" | 1 |
| U03 | `ui/03-session-screen.md` | S5 | D2-morning | C | U02, A05, I04, T05 | `crates/app/src/session/**` | – | "6. Session" | "Session screen" | 1 |
| U04 | `ui/04-inbox-screens.md` | S5 | D2-afternoon | C | U02, I01, I03, I05 | `crates/app/src/inbox/**` | – | "3. Inbox › Lark", "4. Inbox › GitLab", "5. Inbox › Tambah koneksi" | "Inbox: GitLab", "Lark inbox API" | 2 |
| U05 | `ui/05-terminal-rendering.md` | S5 | D2-afternoon | C | U02, T01, T02 | `crates/app/src/terminal/**` | – | "8. Terminal" | "Terminal" | 1 |
| U06 | `ui/06-source-control-diff.md` | S5 | D3-morning | C | U02, I06 | `crates/app/src/source_control/**` | – | "7. Source control" | "Git, files, documents" | 3 |
| U07 | `ui/07-dashboard.md` | S5 | D3-morning | C | U02, T05 | `crates/app/src/dashboard/**` | – | "2. Dashboard" | "Session screen" | 3 |
| U08 | `ui/08-settings.md` | S5 | D3-afternoon | C | U02, A06, T02, I05 | `crates/app/src/settings/**` | – | "10. Settings" | "Settings screen" | 3 |

## Dependency order and merge order

Contracts first: F01, then F02 and F03, then F04. Lanes merge in crate order: contracts, `core`, `store`, `engine`,
`api`, `client`, `app-core`, `ui-kit`, `app`. The lead's merge windows are at the end of each half day (days of 12 working
hours); contract changes are merged at once.

## Cut order

If time runs short, the end of the schedule moves to after day 3, in this order: source control per hunk (I06, U06), the
Settings pages (U08, A06's screen work), the FigCraft parity pass. The foundation, the agent session, the Inbox, the bot
and the terminal come first.

## Owner checklist before day 1

- `brew install zig sccache`.
- A Claude API key or setup token in a 0600 file.
- A GitLab personal access token (scope `api`) in a 0600 file, and a test repository of your own.
- `lark-cli` logged in; the bot app made in the Lark console (long connection, permissions) with its ids; one test group.
- Optional: a read-only Postgres role and its credential file, to try the read path for real.

Real services are used only at the owner checkpoints, by the lead, with Claude Haiku; the Claude budget for the three
days is $50.
