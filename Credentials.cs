using System.Net;
using System.Net.Http.Headers;
using System.Text;
using System.Text.RegularExpressions;

namespace DshLauncher;

enum KeyStatus { Valid, Invalid, Unknown }

/// <summary>
/// Reads, validates and saves the DeepSeek API key in dsh's credentials file
/// (<c>$DSH_HOME/.credentials.yaml</c>, <c>refs</c> section).
/// </summary>
static class Credentials
{
    const string BalanceUrl = "https://api.deepseek.com/user/balance";

    static readonly Regex KeyLine = new(@"^(\s+)DEEPSEEK_API_KEY\s*:\s*(.*?)\s*$");
    static readonly Regex RefsLine = new(@"^refs\s*:\s*(\{\s*\})?\s*$");
    static readonly HttpClient Http = new() { Timeout = TimeSpan.FromSeconds(8) };

    public static string DshHome
    {
        get
        {
            var env = Environment.GetEnvironmentVariable("DSH_HOME");
            return !string.IsNullOrWhiteSpace(env)
                ? env
                : Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".dsh");
        }
    }

    public static string FilePath => Path.Combine(DshHome, ".credentials.yaml");

    /// <summary>Stored key, or null if there is no file or it contains none.</summary>
    public static string? ReadKey()
    {
        try
        {
            if (!File.Exists(FilePath)) return null;
            foreach (var line in File.ReadAllLines(FilePath))
            {
                var m = KeyLine.Match(line);
                if (!m.Success) continue;
                var v = m.Groups[2].Value.Trim().Trim('"', '\'');
                return v.Length == 0 ? null : v;
            }
        }
        catch { }
        return null;
    }

    /// <summary>Asks the DeepSeek API whether the key is valid. Returns Unknown when offline.</summary>
    public static async Task<KeyStatus> CheckAsync(string key, CancellationToken ct = default)
    {
        try
        {
            using var req = new HttpRequestMessage(HttpMethod.Get, BalanceUrl);
            req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", key);
            using var resp = await Http.SendAsync(req, ct);
            if (resp.IsSuccessStatusCode) return KeyStatus.Valid;
            if (resp.StatusCode == HttpStatusCode.Unauthorized) return KeyStatus.Invalid;
            return KeyStatus.Unknown;
        }
        catch { return KeyStatus.Unknown; }
    }

    /// <summary>
    /// Writes the key to <c>refs.DEEPSEEK_API_KEY</c> without touching the rest of the file.
    /// A timestamped backup is made first.
    /// </summary>
    public static void SaveKey(string key)
    {
        if (key.Any(char.IsWhiteSpace) || key.Contains('#') || key.Contains(':'))
            throw new ArgumentException("The key contains invalid characters.");

        Directory.CreateDirectory(DshHome);
        string text = File.Exists(FilePath) ? File.ReadAllText(FilePath) : "";
        if (text.Length > 0)
            File.Copy(FilePath, FilePath + ".bak-" + DateTime.Now.ToString("yyyyMMdd-HHmmss"), true);

        string nl = text.Contains("\r\n") ? "\r\n" : "\n";
        var lines = text.Length == 0
            ? new List<string>()
            : text.Replace("\r\n", "\n").Split('\n').ToList();

        string entry = "DEEPSEEK_API_KEY: " + key;
        int existing = lines.FindIndex(l => KeyLine.IsMatch(l));
        if (existing >= 0)
        {
            lines[existing] = KeyLine.Match(lines[existing]).Groups[1].Value + entry;
        }
        else
        {
            int refs = lines.FindIndex(l => RefsLine.IsMatch(l));
            if (refs >= 0)
            {
                lines[refs] = "refs:";
                lines.Insert(refs + 1, "  " + entry);
            }
            else if (lines.Any(l => Regex.IsMatch(l, @"^refs\s*:")))
            {
                throw new InvalidOperationException("Unexpected format in .credentials.yaml (refs section).");
            }
            else
            {
                while (lines.Count > 0 && lines[^1].Trim().Length == 0) lines.RemoveAt(lines.Count - 1);
                if (lines.Count == 0) lines.Add("version: 1");
                lines.Add("refs:");
                lines.Add("  " + entry);
                lines.Add("");
            }
        }

        string tmp = FilePath + ".tmp";
        File.WriteAllText(tmp, string.Join(nl, lines), new UTF8Encoding(false));
        File.Move(tmp, FilePath, true);
    }
}
