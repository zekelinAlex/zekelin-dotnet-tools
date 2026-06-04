# Zekelin .NET Tools

A VS Code extension bundling a handful of .NET / Dataverse developer utilities: publish, wipe `bin/obj`, scoped git push/discard, NuGet-cache cleanup, a `tools-devkit-build`-specific local-feed packager, Dataverse solution unpack/import + package deploy + environment management, and a few other things. Every command streams its progress into a dedicated `Zekelin .NET Tools` output channel and, for long-running ones, shows a progress notification.

## Where each feature shows up

Two surfaces contribute commands: the **Activity Bar view** (opened by clicking the extension's icon in the left rail) and the **Explorer right-click menu**. Some entries are always visible; others appear only when their conditions match.

### Activity Bar view — always visible

These live under the default section and are available in any workspace:

| Button | What it does |
| --- | --- |
| **Clear NuGet Cache** | `dotnet nuget locals all --clear` — wipes every local NuGet cache. |
| **Kill .NET Processes** | `taskkill /IM dotnet.exe /F` — ends every running `dotnet.exe`. |
| **Kill VBCSCompiler** | `taskkill /IM VBCSCompiler.exe /F` — ends the stuck Roslyn compiler that often locks files in `bin/obj`. |

### Activity Bar view — `tools-devkit-build` section

Appears only when the currently open workspace's root folder is named `tools-devkit-build`. The section title matches the folder name and contains two actions:

| Button | When it appears | What it does |
| --- | --- | --- |
| **Install targets Nugets** | workspace root folder = `tools-devkit-build` | Packs every `*.csproj` under `src/Dataverse/` plus `src/Sdk/TALXIS.DevKit.Build.Sdk.csproj` (if present) at a configured version and copies the resulting `*.nupkg` files into a local NuGet feed. See the detailed steps below. |
| **Generate Install Script** | workspace root folder = `tools-devkit-build` | Writes a standalone PowerShell replica of the above into `dev-scripts/Install-TargetNugets.ps1`, along with a `README.md` explaining when to run it, and appends `dev-scripts/` to `.gitignore`. Intended for AI agents / isolated terminals that can't rely on the VS Code sidebar. |

**Install targets Nugets workflow**

1. **Version**: reads `packLocalVersion` from `<repo>/.vscode/zekelin-dotnet-tools.json`. On first run the file doesn't exist, so the extension prompts for a version via an input box once, then saves the answer — every subsequent run reads it from the file without asking. Edit the file manually to change the version later.
2. **Local NuGet feed resolution** (via `dotnet nuget list source`):
   - If a source **named** `Local`/`local` (case-insensitive) already exists, its URL/path is reused.
   - Otherwise, if any source's **path** already matches `C:\NuGetLocal`, that one is reused (even under a different name).
   - Only if neither exists does the extension register a new source named `Local` pointing at `C:\NuGetLocal`.
3. **Pack** — runs `dotnet pack <proj> --configuration Release -p:PackageVersion=<ver> -p:Version=<ver> --output <repo>/artifacts` for each discovered project, one by one, with `(i/N) <name>` progress.
4. **Copy** — every `*.nupkg` from `<repo>/artifacts/` is copied into the resolved local-feed directory.
5. **Cleanup** — kills every `dotnet.exe` process and clears the NuGet cache (`dotnet nuget locals all --clear`).

All five stages run inside a single cancellable progress notification.

**Generate Install Script workflow**

1. Prompts for the package version if it's missing from `<repo>/.vscode/zekelin-dotnet-tools.json` (same config key as above); if the version is already set, no prompt.
2. Creates `<repo>/dev-scripts/` if it doesn't exist.
3. Writes `<repo>/dev-scripts/Install-TargetNugets.ps1` — a self-contained PowerShell script that uses `Split-Path $PSScriptRoot -Parent` to locate the repo, reads the version from the config file at runtime, and runs the exact same pipeline as **Install targets Nugets** (same NuGet-feed resolution strategy, same set of target projects, same cleanup steps).
4. Writes `<repo>/dev-scripts/README.md` that explains, up front, that **the script must be run before testing any change made under `src/Dataverse/` or `src/Sdk/`**. The README is written for AI agents that may read it without human prompting and decide whether to run the script as part of a task.
5. Appends `dev-scripts/` to `<repo>/.gitignore` if it isn't already listed (idempotent — won't duplicate entries).

After generation, the script can be invoked from any PowerShell terminal with `./dev-scripts/Install-TargetNugets.ps1` — it doesn't require the VS Code extension to be installed on the machine that runs it.

### Activity Bar view — `Dataverse` section

Always visible. Manages a list of Dataverse environments stored in a **global** config file under the user's home directory, so the same environment list shows up in every workspace and every VS Code variant (stable / Insiders / Cursor) on the machine:

- Windows: `%USERPROFILE%\.zekelin-dotnet-tools\zekelin-dotnet-tools.json`
- macOS / Linux: `~/.zekelin-dotnet-tools/zekelin-dotnet-tools.json`

Schema:

```json
{
  "environments": [
    { "name": "Dev",  "id": "f3f1e28a-14ed-...", "url": "https://orgxxxxxxxx.crm4.dynamics.com/" },
    { "name": "Prod", "id": "",                  "url": "https://yourorg.crm.dynamics.com/" }
  ]
}
```

The buttons sit at the top; saved environments are listed below them as read-only items showing the friendly name (label) and URL (description), with a tooltip exposing `name` / `id` / `url`.

| Button | What it does |
| --- | --- |
| **Add environment** | Prompts for `name` → `id` (GUID, optional) → `url`, then appends a `{name, id, url}` entry to the global config. |
| **Create environment** | Prompts only for `name`, then runs `pac admin create --name "<name>" --currency EUR --region europe --type Developer`. On success, parses the `Environment Url` / `Environment ID` / `Friendly Name` columns from pac's output (fixed-width table parsing using header column positions) and saves them to the global config automatically. |
| **Delete environment** | Shows a QuickPick of saved environments, asks for modal confirmation, then runs `pac admin delete --environment "<id-or-url>" --async`. On success the entry is removed from the global config. If pac reports the environment as not found (`not found` / `does not exist` / `EnvironmentNotFound` / `no environment` in the output), the entry is also removed — it's already gone server-side. Any other failure leaves the config untouched so you can retry. |
| **Reveal config** | Opens the global config file in the editor (creates an empty one if it doesn't exist yet) so you can edit/reorder/comment-clean entries by hand. |

**Migration.** Earlier versions stored environments in `<workspace>/.vscode/zekelin-dotnet-tools.json` per project. On first activation after upgrade, the extension reads that file from the currently-open workspace and moves any `environments` entries up to the global config (then strips them from the workspace file). A one-time info notification tells you when this happened. `packLocalVersion` stays project-local in `<workspace>/.vscode/zekelin-dotnet-tools.json` — it really is per-repo state.

### Explorer right-click menu — conditional entries

Right-click any file or folder in the Explorer; the relevant entries only appear when their conditions match so the menu stays uncluttered.

| Entry | Visible when you right-click… | What it does |
| --- | --- | --- |
| **Publish** | a `.csproj`/`.sln`/`.slnx` file, **or** any folder that contains at least one of those anywhere in its subtree | Runs `dotnet publish -c Release`. Target resolution: the clicked file itself; or — if a folder — the first `.sln`/`.slnx`/`.csproj` directly inside; or every `.sln`/`.slnx` found in the subtree (or every `.csproj` if no solutions exist). Multiple targets are published sequentially with live output streaming and `(i/N)` progress. |
| **.NET Wipe** | a `.csproj` file, **or** any folder that contains at least one `.csproj` anywhere in its subtree | First runs `taskkill` against `VBCSCompiler.exe` to release file locks, then deletes `bin/` and `obj/` for every project folder under the clicked path in a single elevated PowerShell call (UAC prompt appears once). |
| **Push** | any file or folder with uncommitted changes (tracked via the built-in Git extension) | Prompts for a commit message, then `git add <path>` + `git commit -m <msg> -- <path>` (pathspec commit, so other staged changes outside the path are left alone) + `git push origin <current-branch>`. |
| **Discard** | any file or folder with uncommitted changes | Asks for modal confirmation, then `git restore --source=HEAD --staged --worktree -- <path>` (reverts tracked changes) and `git clean -fd -- <path>` (removes untracked files). |
| **Generate Snippet Prefixes** | a `.vscode` folder | Parses every `*.code-snippets` file inside (tolerating JSON comments and trailing commas), extracts each snippet's `prefix`, and writes them line-by-line to `snippet-prefixes/<name>.ps1` at the workspace root. |
| **Dataverse Solutions unpack** | a `.zip` file | Runs `pac solution unpack --zipfile "<zip>" --localize --folder "<zip-without-ext>"` (creates a folder next to the zip with the same base name). On non-zero exit it retries automatically with `--packagetype managed`. |
| **Dataverse Solutions Import** | a `.zip` file | Shows the saved-environments QuickPick (with an inline `+ Add new environment...` option), then runs `pac solution import --path "<zip>" --environment "<url-or-id>"`. The `--environment` argument uses the env's `url` if set, otherwise `id`, otherwise `name`. |
| **Dataverse Package deploy** | a `.zip` file | Same environment picker as above, then runs `pac package deploy --package "<zip>" --environment "<url-or-id>"`. |
| **Send to Local NuGet Feed** *(top of menu)* | a `.nupkg` file | First time: asks for a local feed folder path, validates it exists, registers it as a NuGet source if not already (`dotnet nuget add source ...`), copies the package into it, and saves the path to the global config (`localNugetFeed` key). Subsequent times: copies straight to the saved folder, no prompt. If the saved folder gets deleted between runs, the prompt comes back. |

> How the "appears only when relevant" logic works: on startup the extension indexes the workspace for `.csproj`/`.sln`/`.slnx` files (and refreshes on create/delete via a file-system watcher), and subscribes to the built-in Git extension's repository state. It maintains three VS Code context keys — `dotnetCleanup.publishTargets`, `dotnetCleanup.wipeTargets`, and `dotnetGit.changedPaths` — each a map of the exact paths that qualify. The menu `when` clauses use `resourcePath in <key>`, so VS Code only shows the entry when the right-clicked path is a match. The Dataverse entries use a simpler `resourceExtname == .zip` check.

## Command palette

Every action is also directly invocable via `Ctrl+Shift+P`:

| Command ID | Title |
| --- | --- |
| `dotnet-cleanup.clearNugetCache` | Clear NuGet Cache |
| `dotnet-cleanup.killDotnetProcesses` | Kill .NET Processes |
| `dotnet-cleanup.killVBCSCompiler` | Kill VBCSCompiler |
| `dotnet-cleanup.dotnetWipe` | .NET Wipe |
| `dotnet-cleanup.dotnetPublish` | Publish |
| `dotnet-cleanup.gitPush` | Push |
| `dotnet-cleanup.gitDiscard` | Discard |
| `dotnet-cleanup.installTargetNugets` | Install targets Nugets |
| `dotnet-cleanup.generateInstallScript` | Generate Install Script |
| `dotnet-cleanup.generateSnippetPrefixes` | Generate Snippet Prefixes |
| `dotnet-cleanup.dataverseSolutionUnpack` | Dataverse Solutions unpack |
| `dotnet-cleanup.dataverseSolutionImport` | Dataverse Solutions Import |
| `dotnet-cleanup.dataversePackageDeploy` | Dataverse Package deploy |
| `dotnet-cleanup.addDataverseEnvironment` | Add Dataverse environment |
| `dotnet-cleanup.createDataverseEnvironment` | Create Dataverse environment |
| `dotnet-cleanup.deleteDataverseEnvironment` | Delete Dataverse environment |
| `dotnet-cleanup.revealDataverseEnvironmentsConfig` | Reveal Dataverse environments config |
| `dotnet-cleanup.sendToLocalNugetFeed` | Send to Local NuGet Feed |

## One-time settings applied on first activation

The extension sets `window.title` (user-global) to `${dirty}${rootName}${separator}${appName}` on its first activation, so the OS taskbar shows the workspace folder name instead of the active file. This only happens when `window.title` hasn't been set globally or per-workspace — any explicit user value is respected and left alone. To revert, edit `window.title` in your user settings.json.

## Requirements

- Windows (uses `taskkill` and PowerShell with `RunAs`).
- `dotnet` CLI available on `PATH`.
- `git` CLI available on `PATH` (for Push / Discard).
- `pac` CLI (Power Platform CLI) on `PATH` for the Dataverse features.
- VS Code `^1.74.0`.

## Build & install

```bash
npm install
npm run compile
npx @vscode/vsce package --allow-missing-repository
```

A prebuilt package is produced at `zekelin-dotnet-tools-0.0.1.vsix` — install it via `Extensions: Install from VSIX...`.
