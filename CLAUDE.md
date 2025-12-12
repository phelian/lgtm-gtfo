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
```

### CLI options

- `--folder <name>` - only scan specific github subfolder
- `--skip-mentions` - delete even if @mentioned
- `--skip-review-requests` - delete even if requested reviewer
- `--graph` / `--ews` - override backend

## Architecture

CLI tool that cleans GitHub notification emails for closed/merged PRs where you
weren't involved.

**Flow:** `main.ts` → `src/cli.ts` (arg parsing) → `src/processor.ts`
(orchestration) → backends + github checks

**Backends** (`src/*/emails.ts`):

- `ms-graph/` - Microsoft Graph API with OAuth
- `ews/` - Exchange Web Services with OAuth
- `mail-app/` - macOS Mail.app via AppleScript (workaround for strict org
  policies)

Each backend exports `fetchGitHubEmails()` and `batchMoveToTrash()`.

**GitHub checks** (`src/github/pr.ts`): Uses `gh` CLI to check PR status,
mentions, and review requests.

## Environment

```bash
GITHUB_HANDLE    # your github username (or detected via gh api)
LGTM_BACKEND     # graph (default), ews, or mail-app
```
