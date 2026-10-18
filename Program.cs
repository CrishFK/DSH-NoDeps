using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace DshLauncher;

static class Program
{
    static Mutex? instance;

    [STAThread]
    static void Main()
    {
        instance = new Mutex(true, "DshLauncher.SingleInstance", out bool first);
        if (!first)
        {
            if (!ActivateExistingInstance())
                MessageBox.Show("DSH NoDeps is already running.", "DSH NoDeps");
            return;
        }
        ApplicationConfiguration.Initialize();
        AppPaths.WriteInstallMarker();
        Application.Run(new MainForm());
        ReleaseSingleInstance();
    }

    /// <summary>Brings the already running instance to the front; false if it has no window yet.</summary>
    static bool ActivateExistingInstance()
    {
        try
        {
            using var current = Process.GetCurrentProcess();
            foreach (var p in Process.GetProcessesByName(current.ProcessName))
            {
                using (p)
                {
                    if (p.Id == current.Id) continue;
                    p.Refresh();
                    IntPtr h = p.MainWindowHandle;
                    if (h == IntPtr.Zero) continue;
                    ShowWindow(h, SW_RESTORE);
                    SetForegroundWindow(h);
                    return true;
                }
            }
        }
        catch { }
        return false;
    }

    const int SW_RESTORE = 9;

    [DllImport("user32.dll")]
    static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

    [DllImport("user32.dll")]
    static extern bool SetForegroundWindow(IntPtr hWnd);

    /// <summary>
    /// Lets the installer start while this process is still shutting down: its AppMutex check would otherwise find the
    /// app "running" and refuse to continue.
    /// </summary>
    public static void ReleaseSingleInstance()
    {
        try { instance?.ReleaseMutex(); instance?.Dispose(); } catch { }
        instance = null;
    }
}

sealed class PopupForm : Form
{
    public readonly WebView2 Web = new() { Dock = DockStyle.Fill };

    public PopupForm(Form owner)
    {
        Text = "DeepSeek";
        Owner = owner;
        Icon = owner.Icon;
        StartPosition = FormStartPosition.CenterParent;
        ClientSize = new Size(520, 740);
        Controls.Add(Web);
    }
}

sealed class MainForm : Form
{
    const int PreferredPort = 8421;
    static readonly string BaseTitle = $"DSH NoDeps v{AppUpdate.CurrentVersion}";
    const string WebView2Bootstrapper = "https://go.microsoft.com/fwlink/p/?LinkId=2124703";

    readonly Label status = new()
    {
        Dock = DockStyle.Top,
        Height = 56,
        TextAlign = ContentAlignment.MiddleCenter,
        Font = new Font("Segoe UI", 12f),
        Text = "Starting…",
    };
    // Live output of what the app is doing (downloads, npm…), like a terminal.
    readonly TextBox logBox = new()
    {
        Dock = DockStyle.Fill,
        Multiline = true,
        ReadOnly = true,
        ScrollBars = ScrollBars.Vertical,
        WordWrap = false,
        BorderStyle = BorderStyle.None,
        BackColor = Color.FromArgb(24, 24, 27),
        ForeColor = Color.FromArgb(212, 212, 216),
        Font = new Font("Consolas", 9.5f),
        Visible = false,
    };
    readonly WebView2 web = new() { Dock = DockStyle.Fill, Visible = false };
    readonly CancellationTokenSource cts = new();
    IntPtr job;
    Process? dsh;
    bool closing;

    public MainForm()
    {
        Text = BaseTitle;
        StartPosition = FormStartPosition.CenterScreen;
        ClientSize = new Size(1280, 800);
        MinimumSize = new Size(640, 480);
        using (var s = typeof(MainForm).Assembly.GetManifestResourceStream("app.ico"))
            if (s != null) Icon = new Icon(s);
        Controls.Add(web);
        Controls.Add(logBox);
        Controls.Add(status);
        LoadBounds();
        Shown += async (_, _) => await RunAsync();
        FormClosing += (_, _) => Shutdown();
    }

    void SetStatus(string text)
    {
        if (InvokeRequired) { BeginInvoke(() => SetStatus(text)); return; }
        status.Text = text;
    }

    const int MaxLogChars = 200_000;

    /// <summary>Appends a line to the visible log. Safe to call from any thread.</summary>
    void Log(string line)
    {
        if (closing) return;
        if (InvokeRequired) { try { BeginInvoke(() => Log(line)); } catch { } return; }
        if (!logBox.Visible) logBox.Visible = true;
        logBox.AppendText(line + Environment.NewLine);
        if (logBox.TextLength > MaxLogChars)
            logBox.Text = logBox.Text[^(MaxLogChars / 2)..];
        logBox.SelectionStart = logBox.TextLength;
        logBox.ScrollToCaret();
    }

    async Task RunAsync()
    {
        try
        {
            if (!await EnsureWebView2Async()) { Close(); return; }
            await CheckAppUpdateAsync();
            if (closing) return;
            await EnsureDependenciesAsync();
            if (closing) return;
            await EnsureApiKeyAsync();
            if (closing) return;

            SetStatus("Starting DeepSeek Harness…");
            Log("> dsh web");
            string url = await StartDshAsync();

            SetStatus("Loading interface…");
            Directory.CreateDirectory(AppPaths.Data);
            var env = await CoreWebView2Environment.CreateAsync(null, Path.Combine(AppPaths.Data, "WebView2"));
            await web.EnsureCoreWebView2Async(env);
            web.CoreWebView2.NewWindowRequested += async (_, e) =>
            {
                // The web UI calls `window.open("about:blank")` and later redirects that window to
                // DeepSeek's authorization page (sign-in). It needs a real window to do so.
                if (string.IsNullOrEmpty(e.Uri) || e.Uri == "about:blank")
                {
                    var deferral = e.GetDeferral();
                    try
                    {
                        e.NewWindow = await OpenPopupAsync(env);
                        e.Handled = true;
                    }
                    catch { e.Handled = true; }
                    finally { deferral.Complete(); }
                    return;
                }
                e.Handled = true;
                if (Uri.TryCreate(e.Uri, UriKind.Absolute, out var u) &&
                    (u.Scheme == "http" || u.Scheme == "https"))
                {
                    if (u.IsLoopback) web.CoreWebView2.Navigate(e.Uri);
                    else OpenUrl(e.Uri);
                }
            };
            // "v1.2.0 — <chat name> — DeepSeek Harness": the version first, then the page's own title.
            web.CoreWebView2.DocumentTitleChanged += (_, _) =>
                Text = string.IsNullOrWhiteSpace(web.CoreWebView2.DocumentTitle)
                    ? BaseTitle : $"v{AppUpdate.CurrentVersion} — {web.CoreWebView2.DocumentTitle}";
            web.Visible = true;
            status.Visible = false;
            logBox.Visible = false;
            web.CoreWebView2.Navigate(url);
        }
        catch (OperationCanceledException) when (closing) { }
        catch (Exception ex)
        {
            if (closing) return;
            MessageBox.Show(ex.Message, "DSH NoDeps", MessageBoxButtons.OK, MessageBoxIcon.Error);
            Close();
        }
    }

    static void OpenUrl(string url)
    {
        try { Process.Start(new ProcessStartInfo(url) { UseShellExecute = true }); } catch { }
    }

    // ---- WebView2 -----------------------------------------------------------

    static bool WebView2Installed()
    {
        try { return !string.IsNullOrEmpty(CoreWebView2Environment.GetAvailableBrowserVersionString()); }
        catch { return false; }
    }

    /// <summary>Windows 11 and Edge already ship it. If it is missing, Microsoft's official component is installed.</summary>
    async Task<bool> EnsureWebView2Async()
    {
        if (WebView2Installed()) return true;

        if (MessageBox.Show(
                "Microsoft Edge WebView2 Runtime is missing. It is the Windows component that draws the interface.\n\n" +
                    "Download and install it now? (It is an official Microsoft component; Windows may ask for permission)",
                "DSH NoDeps", MessageBoxButtons.YesNo, MessageBoxIcon.Question) != DialogResult.Yes)
            return false;

        string setup = Path.Combine(Path.GetTempPath(), "MicrosoftEdgeWebview2Setup.exe");
        try
        {
            SetStatus("Downloading WebView2…");
            await Toolchain.DownloadAsync(WebView2Bootstrapper, setup, (_, _) => { }, cts.Token);
            SetStatus("Installing WebView2…");
            using var p = Process.Start(new ProcessStartInfo(setup, "/silent /install") { UseShellExecute = true })!;
            await p.WaitForExitAsync(cts.Token);
        }
        finally
        {
            try { File.Delete(setup); } catch { }
        }

        if (WebView2Installed()) return true;
        MessageBox.Show("WebView2 could not be installed. Install it from Microsoft's website and open the application again.",
            "DSH NoDeps", MessageBoxButtons.OK, MessageBoxIcon.Warning);
        return false;
    }

    // ---- New version of this app ---------------------------------------------

    /// <summary>
    /// Looks for a newer release of DSH NoDeps on GitHub. If the user says yes it downloads the installer (with a
    /// progress bar), verifies its SHA-256, runs it silently and closes so it can replace the app, which the
    /// installer then starts again. Offline, or with no releases yet, it says nothing.
    /// </summary>
    async Task CheckAppUpdateAsync()
    {
        AppUpdate.CleanLeftovers();
        SetStatus("Checking for a new version of DSH NoDeps…");
        if (await AppUpdate.CheckAsync(cts.Token) is not { } update) return;

        bool canSelfUpdate = update.InstallerUrl != null && update.ChecksumUrl != null;
        var answer = MessageBox.Show(
            $"A new version of DSH NoDeps is available.\n\nYou have: {AppUpdate.CurrentVersion}\nNew: {update.Version}\n\n" +
            (canSelfUpdate ? "Update now? The app will restart when it is done." : "Open the download page?"),
            "DSH NoDeps", MessageBoxButtons.YesNo, MessageBoxIcon.Information);
        if (answer != DialogResult.Yes) return;

        if (!canSelfUpdate) { OpenUrl(update.PageUrl); return; } // a release without installer/checksum assets

        string? installer;
        using (var form = new UpdateForm(update))
        {
            form.ShowDialog(this);
            installer = form.InstallerPath;
        }
        if (installer == null || closing) return; // cancelled or failed: carry on with the current version

        // Hand over to the installer: /SILENT shows only its own progress window, /relaunch=1 makes it start the
        // new version when it finishes. Release the single-instance mutex first, then get out of its way.
        SetStatus($"Installing DSH NoDeps v{update.Version}…");
        try
        {
            Program.ReleaseSingleInstance();
            Process.Start(new ProcessStartInfo(installer, "/SILENT /NORESTART /relaunch=1") { UseShellExecute = true });
            Close();
        }
        catch (Exception ex)
        {
            MessageBox.Show($"Could not start the installer.\n\n{ex.Message}", "DSH NoDeps", MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }
    }

    // ---- Own dependencies (portable Node and dsh) ----------------------------

    /// <summary>
    /// Puts Node.js and dsh in the runtime folder and, on every launch, tries to update both to the latest.
    /// If there is no network or an update fails, it carries on with what is already there.
    /// </summary>
    async Task EnsureDependenciesAsync()
    {
        await Toolchain.EnsureNodeAsync(SetStatus, Log, cts.Token);
        await Toolchain.EnsureDshAsync(SetStatus, Log, cts.Token);
    }

    // ---- API key -------------------------------------------------------

    /// <summary>
    /// If a key is stored and DeepSeek rejects it (401), asks for a new one. With no stored key it does
    /// nothing: the user can sign in with their DeepSeek account from the UI itself.
    /// </summary>
    async Task EnsureApiKeyAsync()
    {
        string? key = Credentials.ReadKey();
        if (string.IsNullOrEmpty(key)) return;

        SetStatus("Checking the API key…");
        if (await Credentials.CheckAsync(key, cts.Token) != KeyStatus.Invalid) return;

        using var dialog = new ApiKeyForm();
        dialog.ShowDialog(this);
    }

    // ---- Popup windows (sign-in) -----------------------------------------

    // Shares the environment (and therefore cookies and session) with the main window.
    async Task<CoreWebView2> OpenPopupAsync(CoreWebView2Environment env)
    {
        var form = new PopupForm(this);
        form.Show(this);
        await form.Web.EnsureCoreWebView2Async(env);
        var core = form.Web.CoreWebView2;
        core.WindowCloseRequested += (_, _) => form.Close();
        core.DocumentTitleChanged += (_, _) =>
        {
            if (!string.IsNullOrWhiteSpace(core.DocumentTitle)) form.Text = core.DocumentTitle;
        };
        core.NewWindowRequested += (_, e) =>
        {
            e.Handled = true;
            if (Uri.TryCreate(e.Uri, UriKind.Absolute, out var u) &&
                (u.Scheme == "http" || u.Scheme == "https"))
                core.Navigate(e.Uri);
        };
        return core;
    }

    // ---- dsh server ------------------------------------------------------

    async Task<string> StartDshAsync()
    {
        int port = IsPortFree(PreferredPort) ? PreferredPort : 0;

        var psi = new ProcessStartInfo(Toolchain.NodeExe)
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        psi.ArgumentList.Add(Toolchain.DshBin);
        psi.ArgumentList.Add("web");
        psi.ArgumentList.Add("--no-open");
        psi.ArgumentList.Add("--port");
        psi.ArgumentList.Add(port.ToString());
        Toolchain.ApplyEnvironment(psi);
        Log("> native picker owner: " + Toolchain.PatchNativePickerOwner());

        dsh = Process.Start(psi)!;
        AssignToKillOnCloseJob(dsh);

        var urlTcs = new TaskCompletionSource<string>(TaskCreationOptions.RunContinuationsAsynchronously);
        var log = new System.Text.StringBuilder();
        var rx = new Regex(@"https?://\S+");
        int urlSeen = 0;
        DataReceivedEventHandler handler = (_, e) =>
        {
            if (e.Data == null) return;
            lock (log) log.AppendLine(e.Data);
            Log(Regex.Replace(e.Data, @"token=[\w-]+", "token=…")); // the token is never shown
            var m = rx.Match(e.Data);
            if (m.Success && e.Data.Contains("dsh web"))
            {
                Interlocked.Exchange(ref urlSeen, 1);
                urlTcs.TrySetResult(m.Value);
            }
        };
        dsh.OutputDataReceived += handler;
        dsh.ErrorDataReceived += handler;
        dsh.BeginOutputReadLine();
        dsh.BeginErrorReadLine();
        dsh.EnableRaisingEvents = true;
        dsh.Exited += (_, _) =>
        {
            urlTcs.TrySetException(new Exception("dsh exited while starting.\n\n" + Toolchain.Tail(log.ToString())));
            // Before the URL is printed RunAsync already reports the startup failure; only warn once
            // the server has actually been running.
            if (!closing && Volatile.Read(ref urlSeen) == 1) BeginInvoke(() =>
            {
                MessageBox.Show("The DeepSeek Harness server has stopped.", "DSH NoDeps",
                    MessageBoxButtons.OK, MessageBoxIcon.Warning);
                Close();
            });
        };

        var done = await Task.WhenAny(urlTcs.Task, Task.Delay(TimeSpan.FromSeconds(60), cts.Token));
        if (done != urlTcs.Task)
            throw new Exception("dsh did not respond within 60 s.\n\n" + Toolchain.Tail(log.ToString()));
        return await urlTcs.Task;
    }

    static bool IsPortFree(int port)
    {
        try
        {
            var l = new TcpListener(IPAddress.Loopback, port);
            l.Start();
            l.Stop();
            return true;
        }
        catch { return false; }
    }

    // ---- Shutdown --------------------------------------------------------

    void Shutdown()
    {
        if (closing) return;
        closing = true;
        cts.Cancel();
        SaveBounds();
        try { if (dsh is { HasExited: false }) dsh.Kill(true); } catch { }
        if (job != IntPtr.Zero) { CloseHandle(job); job = IntPtr.Zero; } // kills anything left over
    }

    string BoundsFile => Path.Combine(AppPaths.Data, "window.json");

    void SaveBounds()
    {
        try
        {
            Directory.CreateDirectory(AppPaths.Data);
            var b = WindowState == FormWindowState.Normal ? Bounds : RestoreBounds;
            File.WriteAllText(BoundsFile, JsonSerializer.Serialize(new
            {
                b.X, b.Y, b.Width, b.Height,
                Maximized = WindowState == FormWindowState.Maximized,
            }));
        }
        catch { }
    }

    void LoadBounds()
    {
        try
        {
            if (!File.Exists(BoundsFile)) return;
            using var doc = JsonDocument.Parse(File.ReadAllText(BoundsFile));
            var r = doc.RootElement;
            var rect = new Rectangle(r.GetProperty("X").GetInt32(), r.GetProperty("Y").GetInt32(),
                r.GetProperty("Width").GetInt32(), r.GetProperty("Height").GetInt32());
            if (!Screen.AllScreens.Any(s => s.WorkingArea.IntersectsWith(rect))) return;
            StartPosition = FormStartPosition.Manual;
            Bounds = rect;
            if (r.TryGetProperty("Maximized", out var m) && m.GetBoolean()) WindowState = FormWindowState.Maximized;
        }
        catch { }
    }

    // Job object: if the app dies for any reason, Windows kills dsh and its children.
    void AssignToKillOnCloseJob(Process p)
    {
        job = CreateJobObject(IntPtr.Zero, null);
        var info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        info.BasicLimitInformation.LimitFlags = 0x2000; // KILL_ON_JOB_CLOSE
        int size = Marshal.SizeOf(info);
        IntPtr ptr = Marshal.AllocHGlobal(size);
        try
        {
            Marshal.StructureToPtr(info, ptr, false);
            SetInformationJobObject(job, 9, ptr, (uint)size);
        }
        finally { Marshal.FreeHGlobal(ptr); }
        AssignProcessToJobObject(job, p.Handle);
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    static extern IntPtr CreateJobObject(IntPtr attrs, string? name);
    [DllImport("kernel32.dll")]
    static extern bool SetInformationJobObject(IntPtr job, int cls, IntPtr info, uint len);
    [DllImport("kernel32.dll")]
    static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll")]
    static extern bool CloseHandle(IntPtr h);

    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct IO_COUNTERS
    {
        public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount,
            ReadTransferCount, WriteTransferCount, OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }
}
