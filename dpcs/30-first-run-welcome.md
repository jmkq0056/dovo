# 30 · First-Run Welcome

## What it is

A five-step dialog the first time Dovo starts on a new profile: hello → Ember dark or light → Claude Code (is it installed, how it starts) → keys worth knowing → done. It replaces VS Code's own first-run onboarding (GitHub sign-in, Copilot, VS Code themes), which is switched off with a default for `workbench.welcomePage.experimentalOnboarding`.

`Dovo: Show Welcome` opens it again at any time.

## Files

- `src/vs/workbench/contrib/mautcode/browser/dovoOnboarding.ts`: the dialog, the first-run contribution, the `dovo.welcome.show` action and the `_dovo.onboarding.whenDone` command.
- `src/vs/workbench/contrib/mautcode/browser/media/dovoOnboarding.css`
- `extensions/maut-themes/src/extension.ts`: `_maut.theme.activeMode` / `_maut.theme.setMode`. Both wait for the startup re-apply, so a choice made while Dovo is still starting isn't overwritten. The old "Theme Studio is in the sidebar" toast is gone; the welcome covers it.
- `extensions/maut-claude-images/src/extension.ts`: `_maut.claude.check` (installed? version? install command; never throws). The auto-start on open waits on `_dovo.onboarding.whenDone`, so Claude starts with the permission mode and model chosen in the welcome.
- `mautStartup.ts`: the splash steps aside while the welcome is pending.

## When it shows

Only when all hold: desktop (not web), no `--skip-welcome`, a brand-new application storage (`isNew(APPLICATION)`), and `dovo.onboarding.seen` not set. Existing installs never get it on their own.

## Failure rules

- **Marked seen the moment it opens.** It can never come back on its own, even if it crashes mid-way or the window is killed.
- **Always closable.** Escape (captured on the window), the × button, Skip; focus is trapped inside the dialog.
- **Every step is built in a try.** A step that throws shows "This part couldn't load" and the rest still work.
- **Extensions are optional.** Everything that lives in an extension goes through `callExtension`, which waits at most 8 s for the command to be registered and to finish, then resolves `undefined`:
  - theme: falls back to the plain `Light Modern` / `Dark Modern` theme and says so;
  - Claude check: "Couldn't check for Claude Code right now", with the install command, Copy, Install in a Terminal and Check Again;
  - missing `claude`: the extension's own explanation, plus the same install options.
- **`whenDone` always settles.** Closing, disposal and a failure to open all complete it; anyone waiting (Claude's auto-start) is released.

## Extension activation errors on a fresh profile

`vscode-icons-mac` and `tomoki1207-pdf` are community extensions bundled prebuilt: there is no source to compile, their `out/` *is* the extension. `.gitignore` ignores `/extensions/**/out/`, so neither `out/` was ever committed. Every fresh clone, and every CI release built from one, shipped them broken: "Activating extension 'eddieposey.vscode-icons-mac' failed: Cannot find module …/out/src/index.js", no file icons, and the PDF viewer failing the first time a PDF opens.

Fix: both `out/` folders are vendored from the published packages (Open VSX: `eddieposey.vscode-icons-mac` 7.25.3, `tomoki1207.pdf` 1.2.2, the versions in their `package.json`) and un-ignored at the end of `.gitignore`.

## Default colours

`extensions/configuration-editing/package.json` still carried the Maut crimson as a global `workbench.colorCustomizations` default. Unscoped, it painted every theme, light ones included, whenever Theme Studio hadn't written its own colours yet (before it activates, or if it fails). It is now Ember dark, scoped to `[Dark Modern]`, the default theme.
