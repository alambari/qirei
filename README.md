# Qirei

A personal workbench for an engineer's working day. It gathers notifications from Lark and GitLab, runs a Claude
agent on your own Mac against your own repositories, skills and tools, and answers teammates through a Lark bot.
Routine work runs on its own (answers, searches, merge requests), and you stay in control where it matters: anything
dangerous, such as changing or deleting on a system or writing production data, waits for you, and merges stay manual
after review.

## Status

**Nothing is built yet and nothing runs.** This repository holds the design and the groundwork, not a working
application. What it contains today:

- the design documents: [ARCHITECTURE.md](ARCHITECTURE.md), [UI_DESIGN_GUIDE.md](UI_DESIGN_GUIDE.md),
  [FEATURE.md](FEATURE.md) (every feature, menu by menu, in Indonesian), [JOURNEY.md](JOURNEY.md) (an engineer's day
  and every Lark bot case, in Indonesian), the design document and the first plan under
  `docs/superpowers/`;
- the Claude sidecar in `sidecars/claude` (TypeScript). Its type check and its tests pass, but it only runs when a
  daemon starts it, and there is no daemon yet;
- helper scripts in `scripts/` (checks, development profile, disk sweep);
- the UI design in FigCraft, kept outside git because it holds real data.

The Rust crates (`crates/`), the daemon, the desktop app and the web app do not exist. Everywhere else in this
repository, text that reads as if a part works (the layout table, the build commands, ARCHITECTURE.md) describes the
planned design.

Planned sandbox, and what it will not hide, so you can judge it: every run can read everything outside your home directory (for
example `/private/tmp`, the temporary and cache folders of your other apps and `/Volumes`), and a sandboxed process
can read the environment of any other non-Apple process of your account. So start the daemon from launchd
(`qireid install-agent`) or with a clean environment, and keep secrets out of the environment of long-running
processes of yours. The sandbox is a layer that adds to the permission rules, not a claim that nothing gets
through; ARCHITECTURE.md ("OS sandbox", "Not built or not proven") lists what is known.

Recommended once, on your side: run `git config --global safe.bareRepository explicit` (git 2.38 or later). The
sandbox's git rules stop the ways found so far for an agent to make a repository run code through its `.git`, but
they are a list of names with documented gaps (see ARCHITECTURE.md), and a folder that looks like a bare repository
is refused by git itself only with this setting. A global git setting is yours to change; Qirei never edits it.

## What it does

The planned features, described in full in [FEATURE.md](FEATURE.md). None of them is built yet.

- **Dashboard**: what is waiting for you, your tickets on one track, the agents that are running.
- **Inbox**: Lark mentions and messages, GitLab merge requests and review comments, in one place.
- **Ticket sessions**: one session per ticket for its whole life, with live progress, decision cards instead of
  long questions, a single push gate per run, and notes the agent never forgets.
- **Source control and diff**: stage, discard and commit per file or per hunk, with actions on right-click.
- **Terminal**: tabs and split panes; send output to a session.
- **Lark bot**: answers questions from allowed people in allowed groups; teammates' action requests become
  approvals in your Inbox.
- **Settings**: Claude Code-like skills and connectors you can switch on and off, subagents, budgets, and a
  read-only data path so the agent never touches secret files.

## How it is built

One Rust backend (`qireid`) with one HTTP + WebSocket API. The desktop app (Rust, GPUI) is a client of that
API, and a React web app will be another. Claude runs through the official Claude Agent SDK in a small
TypeScript sidecar; the backend makes every permission decision.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the system, [UI_DESIGN_GUIDE.md](UI_DESIGN_GUIDE.md) for the UI rules agents follow so the interface stays within the FigCraft design (colours, fonts, spacing, buttons, components), and
[docs/superpowers/specs/2026-11-14-qirei-design.md](docs/superpowers/specs/2026-11-14-qirei-design.md) for
the full design.

## Layout

The planned layout. Only `sidecars/claude` and `scripts` exist today; the Rust crates do not.

| Path | Responsibility |
|---|---|
| `crates/core` | Domain model and pure decisions, including the Seatbelt profile renderer; no IO |
| `crates/api-types` | API request, response and event types (TypeScript generated from here) |
| `crates/local` | Paths and token storage shared by the daemon and the desktop app, and `platform.rs`, the only module that names a system location |
| `crates/store` | SQLite |
| `crates/connectors` | Placeholder for Lark; empty at first |
| `crates/runtimes` | Agent runtimes behind one trait (Claude first), and the sandboxed launch of the sidecar |
| `crates/engine` | The running system: sessions, runs, gates, the credential gate and per-run sandbox policy, the GitLab poller and client, the Lark inbox and bot, the read path's Postgres connector, git, files, terminals |
| `crates/api` | HTTP and WebSocket server |
| `crates/daemon` | The `qireid` binary: config, launchd, and the wiring of the agent runtime |
| `crates/client` | Rust client for the API, used by the desktop app |
| `crates/app-core` | The app's pure logic: view models, fixed texts and client calls, without GPUI |
| `crates/ui-kit` | App components wrapped around GPUI |
| `crates/app` | Desktop binary: renders `app-core` view models with `ui-kit` |
| `crates/e2e` | End-to-end tests against a real daemon with fakes |
| `sidecars/claude` | Claude Agent SDK sidecar (TypeScript) |

The read path is not a crate: its pure rules (statement check, masking, limits) are in `core`, and the tool, the audit
and the Postgres connector are in `engine`. The GitLab client lives in `engine` too, so the daemon owns every network
side effect. The app's terminal engine is the `terminal-vt` crate, built on libghostty-vt.

## Build and run

Planned requirements: macOS and Rust (edition 2024). **Qirei runs on macOS only.** The daemon relies on four
things macOS provides: the Seatbelt sandbox (`sandbox-exec`) that confines every agent run, launchd as the service manager (`qireid install-agent`), and permission rules that read shell
commands as POSIX shell. Without a sandbox launcher the daemon refuses to run agents rather than run them unconfined.
Every platform specific location or program (the sandbox launcher, the service folders, the home-relative
secret folders, the group database) is named in one module, `crates/local/src/platform.rs`, and nowhere else;
`scripts/platform-boundary.sh` and a Rust test fail when a system path appears elsewhere (see ARCHITECTURE.md, "System
locations and how to override them" and "Towards other platforms"). The agent sandbox has been tested on macOS 26 only;
on another version a rejected profile keeps agent runs off, and nothing else is known. `scripts/dev.sh` also needs
[watchexec](https://github.com/watchexec/watchexec) (`brew install watchexec`). Agent runs need Node.js 26 (for the
sidecar, see `sidecars/claude/README.md`) and a Claude API key or setup token in a mode-0600 file in `~/Library/Application Support/Qirei/secrets/`
(`claude-api-key` or `claude-setup-token`, written from Settings or by hand); without them the daemon starts with agent runs off. Zig is needed to build the terminal library. The integrations are
optional and off until configured: GitLab needs the `gitlab` object in `config.json` and the token file `secrets/gitlab`, Lark needs `lark-cli` on the
daemon's `PATH` and a `lark` object (and `lark.bot` for the bot), and the read path needs `readpath` with the private
file `secrets/readpath.env`. Configuration is `~/.config/qirei/config.json` (JSONC, edited by you, never written by the
daemon, reloaded when it changes); the few preferences the app saves (theme, language, notifications, terminal font)
go to `prefs.json`. Nothing is configured in the database and no secret is in the Keychain.

| Command | What it does |
|---|---|
| `scripts/check.sh` | `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings` and `cargo test --workspace` |
| `scripts/platform-boundary.sh` | Fails with file and line when a system path literal (`/usr`, `/etc`, `~/Library`, `.ssh` ...) appears in `crates/**/*.rs` or the sidecar sources outside `crates/local/src/platform.rs`; tests, comments and inline test modules are exempt, and a line may carry `platform-boundary: allow (reason)` |
| `scripts/check-sidecar.sh` | In `sidecars/claude`: `npm ci --ignore-scripts`, `npm run build`, `npm test`, and a check that the copied bindings match `crates/runtimes/bindings`; needs Node 26.10.0 (`.nvmrc`) |
| `scripts/dev.sh` | The development profile with rebuild on save: restarts `qireid` and the desktop app when their crates change |
| `scripts/e2e-real.sh setup \| run \| stop` | End-to-end scenarios with real services in a separate profile, data folder and scratch repository; its guide is not in this repository yet |
| `cargo run -p qirei-daemon` | Runs `qireid` in the foreground (production profile) |
| `cargo run -p qirei-daemon -- install-agent` | Writes the launchd agent plist for `qireid` and prints the command that loads it |
| `cargo run -p qirei-client --example agent_run -- --socket <sock> --token-file <file> --cwd <dir> "<prompt>"` | Starts one agent run and answers its decisions on stdin; its smoke guide is not in this repository yet |
| `cargo run -p qirei-app` | The desktop app; when no daemon answers it starts the `qireid` next to its own executable, so run `cargo build -p qirei-daemon` first |

## Your workflow stays yours

Ticket key formats, board columns, which skill runs at which moment, folder layouts and data sources are all
configuration in `~/.config/qirei/config.json`. The repository contains no workflow of any specific team.

## Contributing

Read [AGENTS.md](AGENTS.md) before changing anything; it applies to people and coding agents alike.
