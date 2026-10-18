using System.Diagnostics;
using System.IO.Compression;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace DshLauncher;

/// <summary>
/// The app's own dependencies, with nothing installed on the system:
/// a portable Node.js and dsh (<c>@deepseek-ai/dsh</c>) inside the <c>runtime</c> folder.
/// </summary>
static class Toolchain
{
    public const string Package = "@deepseek-ai/dsh";
    const string FallbackNode = "v24.22.0";
    const string AllowScripts = "@deepseek-ai/dsh-subprocess-local,koffi,node-pty,@google/genai,protobufjs";

    static readonly HttpClient Http = new() { Timeout = Timeout.InfiniteTimeSpan };

    /// <summary>Portable Node.js, dsh and the npm cache. See <see cref="AppPaths"/>.</summary>
    public static readonly string Root = AppPaths.Runtime;

    public static string NodeDir => Path.Combine(Root, "node");
    public static string NodeExe => Path.Combine(NodeDir, "node.exe");
    static string NpmCli => Path.Combine(NodeDir, "node_modules", "npm", "bin", "npm-cli.js");
    public static string DshPrefix => Path.Combine(Root, "dsh");
    static string DshPackageDir => Path.Combine(DshPrefix, "node_modules", "@deepseek-ai", "dsh");
    public static string DshBin => Path.Combine(DshPackageDir, "lib", "bin.js");

    public static bool NodeInstalled => File.Exists(NodeExe) && File.Exists(NpmCli);
    public static bool DshInstalled => File.Exists(DshBin);

    /// <summary>Prepends node.exe to the PATH of a child process so dsh and npm scripts can find it.</summary>
    public static void ApplyEnvironment(ProcessStartInfo psi)
    {
        psi.Environment["PATH"] = NodeDir + ";" + (Environment.GetEnvironmentVariable("PATH") ?? "");
    }

    // ---- Versions -------------------------------------------------------

    public static string? InstalledDshVersion()
    {
        try
        {
            using var doc = JsonDocument.Parse(File.ReadAllText(Path.Combine(DshPackageDir, "package.json")));
            return doc.RootElement.GetProperty("version").GetString();
        }
        catch { return null; }
    }

    /// <summary>
    /// The highest version published under any npm tag (latest, next, alpha…), so the app always
    /// tracks the newest build even though DeepSeek has not marked anything as stable.
    /// </summary>
    public static async Task<string?> LatestDshVersionAsync(CancellationToken ct)
    {
        var (code, output) = await RunNpmAsync(null, ct, "view", Package, "dist-tags", "--json");
        if (code != 0) return null;
        try
        {
            int start = output.IndexOf('{'), end = output.LastIndexOf('}');
            if (start < 0 || end < start) return null;
            using var doc = JsonDocument.Parse(output[start..(end + 1)]);
            string? best = null;
            foreach (var tag in doc.RootElement.EnumerateObject())
            {
                var v = tag.Value.GetString();
                if (v == null || !Regex.IsMatch(v, @"^\d+\.\d+\.\d+(-[\w.]+)?$")) continue;
                if (best == null || CompareVersions(v, best) > 0) best = v;
            }
            return best;
        }
        catch { return null; }
    }

    /// <summary>Compares "0.2.1-rc.2" with "0.2.0-rc.2" (a leading "v" is accepted). No suffix counts as stable, i.e. greater.</summary>
    public static int CompareVersions(string a, string b)
    {
        static (int[] nums, string pre) Parse(string v)
        {
            var parts = v.TrimStart('v').Split('-', 2);
            var nums = parts[0].Split('.').Select(x => int.TryParse(x, out var n) ? n : 0).ToArray();
            return (nums, parts.Length > 1 ? parts[1] : "~");
        }
        var (an, ap) = Parse(a);
        var (bn, bp) = Parse(b);
        for (int i = 0; i < Math.Max(an.Length, bn.Length); i++)
        {
            int x = i < an.Length ? an[i] : 0, y = i < bn.Length ? bn[i] : 0;
            if (x != y) return x.CompareTo(y);
        }
        return string.CompareOrdinal(ap, bp);
    }

    /// <summary>
    /// Installs dsh if missing (mandatory) or updates it to the latest version (optional: if that fails
    /// the current one is kept). Throws only when dsh ends up unusable.
    /// </summary>
    public static async Task EnsureDshAsync(Action<string> status, Action<string> log, CancellationToken ct)
    {
        if (!DshInstalled)
        {
            status("Installing DeepSeek Harness…");
            string? first = await TryLatestAsync(ct);
            var (code, output) = await InstallDshAsync(first ?? "next", log, ct);
            if (code != 0 || !DshInstalled)
                throw new Exception($"Could not install DeepSeek Harness.\n\n{Tail(output)}");
            return;
        }

        try
        {
            status("Checking for DeepSeek Harness updates…");
            string? latest = await TryLatestAsync(ct);
            string? installed = InstalledDshVersion();
            if (latest == null || (installed != null && CompareVersions(latest, installed) <= 0)) return;

            status($"Updating DeepSeek Harness to {latest}…");
            await InstallDshAsync(latest, log, ct);
        }
        catch (OperationCanceledException) { throw; }
        catch { /* keep the current version */ }

        // If a half-finished update left it broken, reinstall from scratch.
        if (!DshInstalled)
        {
            status("Repairing DeepSeek Harness…");
            var (code, output) = await InstallDshAsync("next", log, ct);
            if (code != 0 || !DshInstalled)
                throw new Exception($"DeepSeek Harness was left damaged after updating and could not be repaired.\n\n{Tail(output)}");
        }
    }

    static async Task<string?> TryLatestAsync(CancellationToken ct)
    {
        try
        {
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
            timeout.CancelAfter(TimeSpan.FromSeconds(20));
            return await LatestDshVersionAsync(timeout.Token);
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested) { return null; }
        catch { return null; }
    }

    public static string Tail(string s)
    {
        var lines = s.Split('\n');
        return string.Join("\n", lines.Skip(Math.Max(0, lines.Length - 12)));
    }

    // ---- Portable Node.js -----------------------------------------------

    /// <summary>
    /// Installs Node.js if missing and otherwise updates it to the latest LTS. A failed update
    /// (offline, corrupt download…) is not an error: the version that already works is kept.
    /// </summary>
    public static async Task EnsureNodeAsync(Action<string> status, Action<string> log, CancellationToken ct)
    {
        if (!NodeInstalled)
        {
            Directory.CreateDirectory(Root);
            status("Preparing Node.js…");
            await InstallNodeAsync(status, log, (await LatestNodeLtsAsync(ct, fallback: true))!, ct);
            return;
        }

        try
        {
            status("Checking for Node.js updates…");
            string? latest = await LatestNodeLtsAsync(ct, fallback: false);
            string? installed = await InstalledNodeVersionAsync(ct);
            if (latest != null && (installed == null || CompareVersions(latest, installed) > 0))
                await InstallNodeAsync(status, log, latest, ct);
        }
        catch (OperationCanceledException) { throw; }
        catch { /* keep the current version */ }
    }

    static async Task<string?> InstalledNodeVersionAsync(CancellationToken ct)
    {
        var psi = new ProcessStartInfo(NodeExe, "--version")
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
        };
        using var p = Process.Start(psi)!;
        var output = await p.StandardOutput.ReadToEndAsync(ct);
        await p.WaitForExitAsync(ct);
        var v = output.Trim();
        return p.ExitCode == 0 && v.StartsWith('v') ? v : null;
    }

    static async Task InstallNodeAsync(Action<string> status, Action<string> log, string version, CancellationToken ct)
    {
        string name = $"node-{version}-win-x64";
        string baseUrl = $"https://nodejs.org/dist/{version}/";
        log($"> Node.js {version}: {baseUrl}{name}.zip");

        string sums = await GetStringAsync(baseUrl + "SHASUMS256.txt", ct);
        string? expected = sums.Split('\n')
            .Select(l => l.Trim().Split(new[] { ' ' }, StringSplitOptions.RemoveEmptyEntries))
            .Where(p => p.Length == 2 && p[1] == name + ".zip")
            .Select(p => p[0]).FirstOrDefault();
        if (expected == null) throw new Exception("Could not get the Node.js checksum.");

        string zip = Path.Combine(Root, name + ".zip");
        string tmp = Path.Combine(Root, "node-extract");
        try
        {
            await DownloadAsync(baseUrl + name + ".zip", zip,
                (done, total) => status(total is long t
                    ? $"Downloading Node.js… {done / 1048576} / {t / 1048576} MB"
                    : $"Downloading Node.js… {done / 1048576} MB"), ct);

            log("> verifying SHA-256 against nodejs.org SHASUMS256.txt");
            status("Verifying Node.js…");
            string actual;
            await using (var fs = File.OpenRead(zip))
                actual = Convert.ToHexString(await SHA256.HashDataAsync(fs, ct));
            if (!actual.Equals(expected, StringComparison.OrdinalIgnoreCase))
                throw new Exception("The Node.js download is corrupt (SHA-256 mismatch). Please try again.");

            log("> extracting Node.js");
            status("Extracting Node.js…");
            if (Directory.Exists(tmp)) Directory.Delete(tmp, true);
            await Task.Run(() => ZipFile.ExtractToDirectory(zip, tmp), ct);

            // Safe swap: the previous version is only deleted once the new one is in place.
            string old = NodeDir + ".old";
            if (Directory.Exists(old)) Directory.Delete(old, true);
            bool hadOld = Directory.Exists(NodeDir);
            if (hadOld) Directory.Move(NodeDir, old);
            try
            {
                Directory.Move(Path.Combine(tmp, name), NodeDir);
                if (!NodeInstalled) throw new Exception("Node.js was downloaded but its contents are not what was expected.");
            }
            catch
            {
                if (Directory.Exists(NodeDir)) Directory.Delete(NodeDir, true);
                if (hadOld) Directory.Move(old, NodeDir);
                throw;
            }
            if (hadOld) try { Directory.Delete(old, true); } catch { }
            log($"> Node.js {version} ready");
        }
        finally
        {
            try { if (File.Exists(zip)) File.Delete(zip); } catch { }
            try { if (Directory.Exists(tmp)) Directory.Delete(tmp, true); } catch { }
        }
    }

    /// <summary>Latest Node LTS for Windows x64. Offline it returns the fallback version, or null.</summary>
    static async Task<string?> LatestNodeLtsAsync(CancellationToken ct, bool fallback)
    {
        try
        {
            using var doc = JsonDocument.Parse(await GetStringAsync("https://nodejs.org/dist/index.json", ct));
            foreach (var release in doc.RootElement.EnumerateArray())
            {
                if (release.GetProperty("lts").ValueKind != JsonValueKind.String) continue;
                if (!release.GetProperty("files").EnumerateArray().Any(f => f.GetString() == "win-x64-zip")) continue;
                return release.GetProperty("version").GetString()!;
            }
        }
        catch (OperationCanceledException) { throw; }
        catch { }
        return fallback ? FallbackNode : null;
    }

    // ---- dsh ----------------------------------------------------------------

    /// <summary>Installs (or updates) dsh in runtime\dsh. <paramref name="version"/> is a version or an npm tag.
    /// If this npm does not understand --allow-scripts, retries without it.</summary>
    static async Task<(int code, string output)> InstallDshAsync(string version, Action<string> log, CancellationToken ct)
    {
        Directory.CreateDirectory(DshPrefix);
        var args = new List<string>
        {
            "install", "--prefix", DshPrefix, $"{Package}@{version}", "--no-audit", "--no-fund",
            "--loglevel=http", // without a terminal npm draws no progress bar; this makes every download visible
        };
        log($"> npm install {Package}@{version}");
        var result = await RunNpmAsync(log, ct, args.Append($"--allow-scripts={AllowScripts}").ToArray());
        if (result.code != 0)
        {
            log("> retrying without --allow-scripts");
            result = await RunNpmAsync(log, ct, args.ToArray());
        }
        return result;
    }

    /// <summary>Runs npm with the portable Node. Each output line is passed to <paramref name="onLine"/> as soon as it appears.</summary>
    public static async Task<(int code, string output)> RunNpmAsync(
        Action<string>? onLine, CancellationToken ct, params string[] args)
    {
        var psi = new ProcessStartInfo(NodeExe)
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            WorkingDirectory = Root,
        };
        psi.ArgumentList.Add(NpmCli);
        foreach (var a in args) psi.ArgumentList.Add(a);
        ApplyEnvironment(psi);
        psi.Environment["npm_config_update_notifier"] = "false";
        // Keep npm from leaving anything outside the runtime folder (by default it would use %LOCALAPPDATA%\npm-cache).
        psi.Environment["npm_config_cache"] = Path.Combine(Root, "npm-cache");

        var sb = new System.Text.StringBuilder();
        DataReceivedEventHandler handler = (_, e) =>
        {
            if (e.Data == null) return;
            lock (sb) sb.AppendLine(e.Data);
            onLine?.Invoke(e.Data);
        };

        using var p = Process.Start(psi)!;
        p.OutputDataReceived += handler;
        p.ErrorDataReceived += handler;
        p.BeginOutputReadLine();
        p.BeginErrorReadLine();
        try { await p.WaitForExitAsync(ct); }
        catch { try { p.Kill(true); } catch { } throw; }
        lock (sb) return (p.ExitCode, sb.ToString());
    }

    // ---- Downloads ----------------------------------------------------------

    static async Task<string> GetStringAsync(string url, CancellationToken ct)
    {
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeout.CancelAfter(TimeSpan.FromSeconds(30));
        return await Http.GetStringAsync(url, timeout.Token);
    }

    public static async Task DownloadAsync(string url, string dest, Action<long, long?> progress, CancellationToken ct)
    {
        using var resp = await Http.GetAsync(url, HttpCompletionOption.ResponseHeadersRead, ct);
        resp.EnsureSuccessStatusCode();
        long? total = resp.Content.Headers.ContentLength;
        await using var src = await resp.Content.ReadAsStreamAsync(ct);
        await using var dst = File.Create(dest);
        var buffer = new byte[81920];
        long done = 0;
        var last = Stopwatch.StartNew();
        int n;
        while ((n = await src.ReadAsync(buffer, ct)) > 0)
        {
            await dst.WriteAsync(buffer.AsMemory(0, n), ct);
            done += n;
            if (last.ElapsedMilliseconds > 200) { progress(done, total); last.Restart(); }
        }
        progress(done, total);
    }
}
