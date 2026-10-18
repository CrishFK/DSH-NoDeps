# DSH NoDeps

**Self-contained launcher for DeepSeek Harness (`dsh web`).** It installs nothing on your system: Node.js and `dsh` live in its own
folder, and everything is removed cleanly when you uninstall it. The "NoDeps" in the name means exactly that: no dependencies to
install first.

> **Unofficial launcher.** This is not DeepSeek's app and it is not made, endorsed or sponsored by DeepSeek. It only starts the
> official DeepSeek Harness CLI ([`@deepseek-ai/dsh`](https://github.com/deepseek-ai/deepseek-harness)) for you and shows its
> interface in a window. See the [disclaimer](DISCLAIMER.md).

## Why DSH NoDeps

- **Zero dependencies to install.** You do not need Node.js, npm or `dsh` on your PC. It brings its own, inside its own folder, and
  ignores any you may already have.
- **Always up to date.** On every launch it updates Node.js (latest LTS) and `dsh` (latest published version) by itself. If you are
  offline, or an update fails, it simply starts with what it already has.
- **Updates itself when you say yes.** On start it checks this repository's releases. If there is a newer version it asks you; on
  *Yes* it shows a download bar, checks the file's SHA-256, installs the new version and starts it again. It never does anything
  without asking, and it says nothing if you are offline.
- **Everything in one folder.** Nothing in the PATH, nothing in environment variables, nothing left scattered around your system. The
  app, Node.js, `dsh`, the npm cache and the browser profile all live in the folder you choose (default `C:\DSH NoDeps`).
- **Clean uninstall.** It deletes that folder, the shortcuts, the uninstall entry and the traces Windows itself records for the
  program in the registry. It then asks separately whether you also want to delete your DeepSeek data (chats, settings, API key).
  The default is **No**.
- **No terminal window.** It starts `dsh` for you and stops it for you. When you close the window, nothing is left running.
- **Tells you when your API key expires.** If the stored key is revoked or no longer valid, it asks for a new one and saves it, so you
  never have to edit a file.
- **No administrator rights needed.** It installs for your user only.

## Install

1. Download `DSH-NoDeps-Setup.exe` from the [Releases](../../releases) page.
2. Run it and pick a folder (default `C:\DSH NoDeps`). Pick an empty or new folder: uninstalling deletes the whole folder, so the
   installer refuses a drive root or a folder that already holds other files.
3. Open **DSH NoDeps** from the Start menu.

**The first run takes a few minutes** (about 3 to 5): it downloads Node.js and installs `dsh`, around 700 MB in roughly 51,000 files.
Most of the time goes into writing that many small files. It happens once, and the window shows a live log so you can see it working.
Later launches only download what changed.

## Uninstall

*Apps > Installed apps* in Windows, or run `unins000.exe` from the install folder. When it asks whether to delete your DeepSeek data,
choose **No** if you want to keep your chats and settings.

## Good to know

- Windows 10/11 (x64) only. It needs an internet connection for the first run and for updates.
- It needs Microsoft's WebView2 Runtime, which ships with Windows 11 and Edge. If it is missing, the app offers to install it.
- **Add workspace** opens the standard Windows folder dialog, so you can change drive, browse network locations and use the usual shortcuts.
- `dsh` has no stable release yet (everything published is an alpha or release candidate), so the app uses the highest version. It can
  have bugs typical of a pre-release.
- The window title shows the app version first and then the name of the current chat, for example
  `v1.0.0 — my chat — DeepSeek Harness`.
- The app and the installer are in English, and so is `dsh`'s own interface (it only ships English and Chinese).
- The installer is not code-signed, so Windows SmartScreen may show a warning the first time it runs.

<details>
<summary>Where things are stored</summary>

| What | Where |
|---|---|
| The app, Node.js, `dsh` and the npm cache | The install folder (`runtime\` inside it) |
| Embedded browser profile and window placement | `data\` inside the install folder |
| Harness configuration, sessions and API key | `%USERPROFILE%\.dsh` or the `DSH_HOME` folder (managed by `dsh`; not deleted unless you say so on uninstall) |

If the `.exe` runs from a folder it cannot write to, those two folders fall back to `%LOCALAPPDATA%\DshLauncher`. The uninstaller
removes that fallback folder only when the marker written by this installation names it.

</details>

<details>
<summary>Build it yourself</summary>

You need the .NET 8 SDK for the app and [Inno Setup 6](https://jrsoftware.org/isinfo.php) for the installer. Inno Setup is only a build
tool; it is not needed to run the app or the installer.

```powershell
# the app only
dotnet publish -c Release -o bin

# the installer (publishes the app to installer\payload, then runs ISCC)
.\installer\build.ps1 -Iscc "C:\path\to\ISCC.exe"
```

The installer is written to `installer\Output\DSH-NoDeps-Setup.exe` (about 57.6 MB). When running from `bin`, `runtime` and `data` are
created inside `bin`, so deleting `bin` to rebuild also deletes the downloaded dependencies (~800 MB).

**Releases:** pushing a tag like `v1.2.0` builds the installer on GitHub and publishes it as a release, with its SHA-256 checksum. A
tag like `v1.2.0-rc.1` is published as a pre-release. The workflow is in `.github/workflows/release.yml`; running it by hand from the
*Actions* tab only builds the installer as a downloadable artifact.

</details>

## Disclaimer

DSH NoDeps is an independent, unofficial launcher. It is not affiliated with DeepSeek, it does not contain or redistribute DeepSeek
Harness (the official packages are downloaded onto your own computer the first time you run it), and "DeepSeek" and its logos belong
to their owners. The name uses the abbreviation "DSH", as DeepSeek Harness's own brand guidelines suggest, and the icon is original.
The software is provided "as is", without warranty, and no open-source license is attached to this repository. The full text is in
[DISCLAIMER.md](DISCLAIMER.md), and the installer shows it before installing.
