namespace DshLauncher;

/// <summary>
/// Where the app keeps everything it owns. All of it lives under one base folder, so removing that
/// folder removes the whole app: the dependencies (<c>runtime</c>) and the app's own data (<c>data</c>).
/// </summary>
static class AppPaths
{
    /// <summary>The install folder (next to the .exe) when it is writable; otherwise %LOCALAPPDATA%\DshLauncher.</summary>
    public static readonly string Base = ResolveBase();

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
            return Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "DshLauncher");
        }
    }
}
