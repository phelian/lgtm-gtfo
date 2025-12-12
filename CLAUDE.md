# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with
code in this repository.

## Critical constraints

- **`gh` CLI is READ-ONLY** - only use `gh` for reading PR status, never for
  modifying anything on GitHub
- This tool deletes **emails**, not PRs

## Commands

```bash
deno task lgtm              # dry run - see what would be deleted
deno task gtfo              # actually move to trash (--confirm)
deno fmt                    # format code
deno lint                   # lint code
deno check src/**/*.ts      # type check
```

### CLI options

- `--folder <name>` - only scan specific github subfolder
- `--skip-mentions` - delete even if @mentioned
- `--skip-review-requests` - delete even if requested reviewer
- `--ci-days <n>` - delete CI/workflow emails older than n days
- `--pending` - list PRs awaiting your review
- `--no-bot` - exclude bot PRs (dependabot, es-robot) from pending
- `--graph` / `--ews` - override backend

## Architecture

CLI tool that cleans GitHub notification emails for closed/merged PRs where you
weren't involved.

```
main.ts → src/cli.ts → src/processor.ts → backends + github checks
```

### Source structure

```
src/
├── cli.ts              # argument parsing, help text
├── processor.ts        # orchestration, deletion logic
├── github/
│   └── pr.ts           # PR status checks, pending reviews (gh CLI)
├── shared/
│   ├── types.ts        # unified email types
│   ├── parse-subject.ts # extract repo/PR from subject
│   └── oauth.ts        # PKCE oauth flow, token storage
├── ms-graph/
│   ├── auth.ts         # Graph API oauth config
│   └── emails.ts       # fetch/delete via Graph API
├── ews/
│   ├── auth.ts         # EWS oauth config
│   └── emails.ts       # fetch/delete via EWS SOAP
└── mail-app/
    └── emails.ts       # fetch/delete via AppleScript
```

### Backend interface

Each backend (`ms-graph`, `ews`, `mail-app`) exports:

- `fetchGitHubEmails(folder?)` - returns `UnifiedEmail[]`
- `batchMoveToTrash(ids)` - moves emails to trash

### Key types

- `UnifiedEmail` - common email type across backends
- `PrCheckResult` - PR status with mentions/reviewer info
- `Backend` - `"graph" | "ews" | "mail-app"`

## Environment

```bash
GITHUB_HANDLE    # your github username (or detected via gh api)
LGTM_BACKEND     # graph (default), ews, or mail-app
```

## Shell aliases

Source `.zsh_completions` for:

- `lgtm` / `gtfo` / `pending` / `todo` aliases
- tab completion for all flags
