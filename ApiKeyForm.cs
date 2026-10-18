using System.Diagnostics;

namespace DshLauncher;

/// <summary>Dialog that asks for a new API key when the stored one is no longer valid.</summary>
sealed class ApiKeyForm : Form
{
    const string KeysPage = "https://platform.deepseek.com/api_keys";

    readonly TextBox box = new() { UseSystemPasswordChar = true, Width = 440 };
    readonly Label error = new() { ForeColor = Color.Firebrick, AutoSize = true, MaximumSize = new Size(440, 0) };
    readonly Button save = new() { Text = "Save and continue", AutoSize = true, Padding = new Padding(8, 2, 8, 2) };
    readonly Button skip = new() { Text = "Continue without changing", AutoSize = true, Padding = new Padding(8, 2, 8, 2) };

    public ApiKeyForm()
    {
        Text = "DSH NoDeps — API key";
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = MinimizeBox = false;
        StartPosition = FormStartPosition.CenterParent;
        AutoScaleMode = AutoScaleMode.Dpi;
        AutoSize = true;
        AutoSizeMode = AutoSizeMode.GrowAndShrink;
        Padding = new Padding(16);

        var info = new Label
        {
            AutoSize = true,
            MaximumSize = new Size(440, 0),
            Text = "The stored API key has expired or been revoked: DeepSeek rejects it.\n\n" +
                    "Create a new one at platform.deepseek.com and paste it here.",
        };
        var link = new LinkLabel { Text = "Open " + KeysPage, AutoSize = true };
        link.LinkClicked += (_, _) =>
            Process.Start(new ProcessStartInfo(KeysPage) { UseShellExecute = true });

        var show = new CheckBox { Text = "Show the key", AutoSize = true };
        show.CheckedChanged += (_, _) => box.UseSystemPasswordChar = !show.Checked;

        var buttons = new FlowLayoutPanel
        {
            AutoSize = true,
            FlowDirection = FlowDirection.RightToLeft,
            Dock = DockStyle.Fill,
            Margin = new Padding(0, 8, 0, 0),
        };
        buttons.Controls.Add(save);
        buttons.Controls.Add(skip);

        var layout = new FlowLayoutPanel
        {
            FlowDirection = FlowDirection.TopDown,
            WrapContents = false,
            AutoSize = true,
        };
        layout.Controls.AddRange(new Control[] { info, link, box, show, error, buttons });
        Controls.Add(layout);

        AcceptButton = save;
        CancelButton = skip;
        skip.Click += (_, _) => { DialogResult = DialogResult.Cancel; };
        save.Click += async (_, _) => await OnSaveAsync();
        Shown += (_, _) => box.Focus();
    }

    async Task OnSaveAsync()
    {
        string key = box.Text.Trim();
        if (key.Length == 0) { error.Text = "Paste the key."; return; }

        SetBusy(true);
        error.Text = "";
        var status = await Credentials.CheckAsync(key);
        if (status == KeyStatus.Invalid)
        {
            error.Text = "DeepSeek rejects this key. Check it or create another one.";
            SetBusy(false);
            return;
        }
        if (status == KeyStatus.Unknown &&
            MessageBox.Show(this, "Could not verify the key (offline?).\n\nSave it anyway?",
                Text, MessageBoxButtons.YesNo, MessageBoxIcon.Question) != DialogResult.Yes)
        {
            SetBusy(false);
            return;
        }
        try
        {
            Credentials.SaveKey(key);
            DialogResult = DialogResult.OK;
        }
        catch (Exception ex)
        {
            error.Text = "Could not save: " + ex.Message;
            SetBusy(false);
        }
    }

    void SetBusy(bool busy)
    {
        save.Enabled = skip.Enabled = box.Enabled = !busy;
        save.Text = busy ? "Checking…" : "Save and continue";
    }
}
