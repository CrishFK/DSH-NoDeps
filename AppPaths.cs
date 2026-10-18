namespace DshLauncher;

/// <summary>
/// Where the app keeps everything it owns. All of it lives under one base folder, so removing that
/// folder removes the whole app: the dependencies (<c>runtime</c>) and the app's own data (<c>data</c>).
/// </summary>
static class AppPaths
{
    /// <summary>The install folder (next to the .exe) when it is writable; otherwise %LOCALAPPDATA%\DshLauncher.</summary>
    public static readonly string Base = ResolveBase();

    /// <summary>True when <see cref="Base"/> is the %LOCALAPPDATA% fallback rather than the .exe folder.</summary>
    public static bool UsesFallback { get; private set; }

    /// <summary>Portable Node.js, dsh and the npm cache.</summary>
    public static string Runtime => Path.Combine(Base, "runtime");

    /// <summary>The embedded browser profile (cookies, preferences) and window placement.</summary>
    public static string Data => Path.Combine(Base, "data");

    static string ResolveBase()
    {
        var exeDir = Path.GetDirectoryName(Environment.ProcessPath) ?? AppContext.BaseDirectory;
        try
        {
            var probe = Path.Combine(exeDir, ".write-test");
            File.WriteAllText(probe, "");
            File.Delete(probe);
            return exeDir;
        }
        catch
        {
            UsesFallback = true;
            return Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "DshLauncher");
        }
    }

    /// <summary>
    /// Records which install folder owns the fallback data. The uninstaller removes
    /// <c>%LOCALAPPDATA%\DshLauncher</c> only when this marker names that install folder.
    /// </summary>
    public static void WriteInstallMarker()
    {
        if (!UsesFallback) return;
        try
        {
            Directory.CreateDirectory(Base);
            string exeDir = Path.GetDirectoryName(Environment.ProcessPath) ?? AppContext.BaseDirectory;
            File.WriteAllText(Path.Combine(Base, "install-path.ini"),
                "[install]\r\npath=" + exeDir + "\r\n");
        }
        catch { }
    }
}
