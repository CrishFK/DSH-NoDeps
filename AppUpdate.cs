using System.Net.Http.Headers;
using System.Reflection;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace DshLauncher;

/// <summary>A newer release found on GitHub, with the download links of its installer and checksum (when it has them).</summary>
sealed record UpdateInfo(string Version, string PageUrl, string? InstallerUrl, string? ChecksumUrl);

/// <summary>
/// This app's own version, the check for a newer release on GitHub, and the self-update: download the installer,
/// verify its SHA-256 and hand over to it. Nothing here runs unless the user says yes.
/// </summary>
static class AppUpdate
{
    public const string Repo = "CrishFK/DSH-NoDeps";
    public const string InstallerAsset = "DSH-NoDeps-Setup.exe";

    static readonly string DownloadPrefix = $"https://github.com/{Repo}/releases/download/";
    static readonly HttpClient Http = CreateClient();

    /// <summary>The version of this build, e.g. "1.2.0" (set from the git tag by the release workflow).</summary>
    public static readonly string CurrentVersion = ReadVersion();

    /// <summary>Where the installer is downloaded to: inside the install folder, so it never lands anywhere else.</summary>
    public static string UpdateDir => Path.Combine(AppPaths.Base, "update");

    static string ReadVersion()
    {
        var v = Assembly.GetExecutingAssembly().GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion ?? "0.0.0";
        int plus = v.IndexOf('+'); // drop the "+commit" suffix the SDK appends
        return plus >= 0 ? v[..plus] : v;
    }

    static HttpClient CreateClient()
    {
        var c = new HttpClient { Timeout = TimeSpan.FromSeconds(15) };
        c.DefaultRequestHeaders.UserAgent.Add(new ProductInfoHeaderValue("DSH-NoDeps", "1"));
        c.DefaultRequestHeaders.Accept.ParseAdd("application/vnd.github+json");
        return c;
    }

    /// <summary>The newest release if it is newer than this build; null if up to date, offline or the repo has no releases.</summary>
    public static async Task<UpdateInfo?> CheckAsync(CancellationToken ct)
    {
        try
        {
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
            timeout.CancelAfter(TimeSpan.FromSeconds(6));
            var json = await Http.GetStringAsync($"https://api.github.com/repos/{Repo}/releases?per_page=20", timeout.Token);
            return PickNewest(json, CurrentVersion);
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
        catch { return null; } // no network, repo not public yet, rate limit… never a reason to bother the user
    }

    /// <summary>
    /// Highest published release (tag <c>vMAJOR.MINOR.PATCH[-suffix]</c>) that is newer than <paramref name="current"/>.
    /// Drafts are ignored, and pre-releases only count when the running build is itself a pre-release.
    /// Only links that point into this repository's own release downloads are accepted.
    /// </summary>
    public static UpdateInfo? PickNewest(string json, string current)
    {
        bool allowPre = current.Contains('-');
        using var doc = JsonDocument.Parse(json);
        UpdateInfo? best = null;
        foreach (var release in doc.RootElement.EnumerateArray())
        {
            if (release.TryGetProperty("draft", out var draft) && draft.GetBoolean()) continue;
            if (!allowPre && release.TryGetProperty("prerelease", out var pre) && pre.GetBoolean()) continue;

            var m = Regex.Match(release.GetProperty("tag_name").GetString() ?? "", @"^v(\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?)$");
            if (!m.Success) continue;
            var page = release.GetProperty("html_url").GetString();
            if (page == null || !page.StartsWith("https://github.com/", StringComparison.Ordinal)) continue;

            var version = m.Groups[1].Value;
            if (best != null && Toolchain.CompareVersions(version, best.Version) <= 0) continue;

            string? installer = null, checksum = null;
            if (release.TryGetProperty("assets", out var assets) && assets.ValueKind == JsonValueKind.Array)
                foreach (var a in assets.EnumerateArray())
                {
                    var name = a.GetProperty("name").GetString();
                    var url = a.GetProperty("browser_download_url").GetString();
                    if (url == null || !url.StartsWith(DownloadPrefix, StringComparison.Ordinal)) continue;
                    if (name == InstallerAsset) installer = url;
                    else if (name == InstallerAsset + ".sha256") checksum = url;
                }
            best = new UpdateInfo(version, page, installer, checksum);
        }
        return best != null && Toolchain.CompareVersions(best.Version, current) > 0 ? best : null;
    }

    /// <summary>
    /// Downloads the installer into <paramref name="dir"/> and checks it against the release's SHA-256 file.
    /// A file that does not match is deleted and reported as an error. Returns the path of the verified installer.
    /// </summary>
    public static async Task<string> DownloadAndVerifyAsync(
        string installerUrl, string checksumUrl, string dir, Action<long, long?> progress, CancellationToken ct)
    {
        var checksumText = await Http.GetStringAsync(checksumUrl, ct);
        var m = Regex.Match(checksumText, @"\b([0-9a-fA-F]{64})\b");
        if (!m.Success) throw new Exception("The release's checksum file does not contain a SHA-256 value.");
        string expected = m.Groups[1].Value;

        Directory.CreateDirectory(dir);
        string path = Path.Combine(dir, InstallerAsset);
        try
        {
            await Toolchain.DownloadAsync(installerUrl, path, progress, ct);

            string actual;
            await using (var fs = File.OpenRead(path))
                actual = Convert.ToHexString(await SHA256.HashDataAsync(fs, ct));
            if (!actual.Equals(expected, StringComparison.OrdinalIgnoreCase))
                throw new Exception("The downloaded installer is corrupt (its SHA-256 does not match the release's). It was discarded.");
            return path;
        }
        catch
        {
            try { File.Delete(path); } catch { }
            throw;
        }
    }

    /// <summary>Removes a leftover downloaded installer from a previous update. Failure is harmless: it is retried next start.</summary>
    public static void CleanLeftovers()
    {
        try { if (Directory.Exists(UpdateDir)) Directory.Delete(UpdateDir, true); } catch { }
    }
}
