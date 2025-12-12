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
deno task lgtm --ci-days 3             # also delete CI emails older than 3 days
```

### Pending reviews

List PRs awaiting your review, grouped by status:

- **Needs 1 more approval** - your review would unblock the PR
- **Needs more approvals** - still needs multiple reviews
- **Changes requested** - someone requested changes
- **Approved** - approved but not yet merged

```bash
deno task lgtm --pending               # list PRs awaiting your review
deno task lgtm --pending --no-bot      # exclude dependabot/es-robot PRs
```

### Shell completions

Source `.zsh_completions` for aliases with tab completion:

```bash
source .zsh_completions
lgtm                                   # dry run
gtfo                                   # actually delete
pending                                # list all PRs awaiting review
todo                                   # list PRs awaiting review (no bots)
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
