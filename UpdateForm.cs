namespace DshLauncher;

/// <summary>The "downloading the new version" window: a progress bar, a Cancel button, and the verified installer path at the end.</summary>
sealed class UpdateForm : Form
{
    readonly UpdateInfo update;
    readonly Label label = new() { AutoSize = true, MaximumSize = new Size(420, 0) };
    readonly ProgressBar bar = new() { Width = 420, Height = 22, Style = ProgressBarStyle.Marquee, MarqueeAnimationSpeed = 30 };
    readonly Button cancel = new() { Text = "Cancel", AutoSize = true, Padding = new Padding(10, 2, 10, 2) };
    readonly CancellationTokenSource cts = new();

    /// <summary>Set when the installer was downloaded and verified; null if cancelled or failed.</summary>
    public string? InstallerPath { get; private set; }

    public UpdateForm(UpdateInfo update)
    {
        this.update = update;
        Text = "DSH NoDeps — update";
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = MinimizeBox = ControlBox = false;
        StartPosition = FormStartPosition.CenterParent;
        AutoScaleMode = AutoScaleMode.Dpi;
        AutoSize = true;
        AutoSizeMode = AutoSizeMode.GrowAndShrink;
        Padding = new Padding(16);

        label.Text = $"Downloading DSH NoDeps v{update.Version}…";
        var layout = new FlowLayoutPanel { FlowDirection = FlowDirection.TopDown, WrapContents = false, AutoSize = true };
        cancel.Margin = new Padding(0, 12, 0, 0);
        layout.Controls.AddRange(new Control[] { label, bar, cancel });
        Controls.Add(layout);

        cancel.Click += (_, _) => { cancel.Enabled = false; cts.Cancel(); };
        Shown += async (_, _) => await RunAsync();
        FormClosed += (_, _) => cts.Cancel();
    }

    async Task RunAsync()
    {
        try
        {
            InstallerPath = await AppUpdate.DownloadAndVerifyAsync(
                update.InstallerUrl!, update.ChecksumUrl!, AppUpdate.UpdateDir, ShowProgress, cts.Token);
            label.Text = "Verified. Installing…";
        }
        catch (OperationCanceledException) { InstallerPath = null; }
        catch (Exception ex)
        {
            InstallerPath = null;
            MessageBox.Show(this, $"The update could not be downloaded.\n\n{ex.Message}\n\nThe app will keep running the current version.",
                "DSH NoDeps", MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }
        Close();
    }

    // Called from the download loop, which resumes on the UI thread.
    void ShowProgress(long done, long? total)
    {
        if (total is long t && t > 0)
        {
            bar.Style = ProgressBarStyle.Continuous;
            bar.Value = (int)Math.Min(100, done * 100 / t);
            label.Text = $"Downloading DSH NoDeps v{update.Version}…  {done / 1048576} / {t / 1048576} MB";
        }
        else label.Text = $"Downloading DSH NoDeps v{update.Version}…  {done / 1048576} MB";
    }
}
