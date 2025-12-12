# lgtm-gtfo

Looks Good To Me? Get The F*** Out (of my inbox).

Cleans up GitHub notification emails for closed/merged PRs where you weren't
specifically mentioned or requested as reviewer.

## Setup

Assumes nix with direnv integration.

```bash
cp .env.local.example .env.local
# edit .env.local with your settings
direnv allow
```

**.env.local:**

```bash
GITHUB_HANDLE="your-github-username"
LGTM_BACKEND="graph"  # graph, ews, or mail-app
```

## Usage

```bash
deno task lgtm              # dry run - see what would be deleted
deno task gtfo              # actually move to trash
```

### Options

```bash
deno task lgtm --folder dependabot     # only scan specific subfolder
deno task lgtm --skip-mentions         # delete even if @mentioned
deno task lgtm --skip-review-requests  # delete even if requested reviewer
```

## Backends

| Backend    | Description                    |
| ---------- | ------------------------------ |
| `graph`    | Microsoft Graph API (default)  |
| `ews`      | Exchange Web Services          |
| `mail-app` | macOS Mail.app via AppleScript |

Override per-run with `--graph`, `--ews`, or set `LGTM_BACKEND` in `.env.local`.

### Mail.app workaround

If your org blocks OAuth for Graph/EWS (conditional access policies,
unregistered devices, etc.), use `mail-app` backend as a workaround:

1. Add your Exchange account to macOS Mail.app (same auth flow as iOS Mail)
2. Set `LGTM_BACKEND="mail-app"` in `.env.local`

This works because Mail.app uses the system's trusted Exchange authentication
rather than OAuth.

## How it works

1. Scans `github/*` folders for emails from `notifications@github.com`
2. Extracts repo/PR info from email subjects
3. Checks PR status via `gh` CLI
4. Keeps emails where you were @mentioned or requested as reviewer
5. Trashes the rest (closed/merged PRs you weren't involved in)
