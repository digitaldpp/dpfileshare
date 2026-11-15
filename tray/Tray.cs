// DP File Share tray icon. Starts with Windows and does nothing but sit in the tray until you
// turn sharing on, so it costs next to nothing at boot. Build with build-tray.ps1.

using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Text;
using System.IO;
using System.Net;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

static class Program
{
    [STAThread]
    static void Main()
    {
        bool first;
        using (var mutex = new Mutex(true, "DPFileShareTray", out first))
        {
            if (!first) return; // already in the tray
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new TrayApp());
        }
    }
}

class TrayApp : ApplicationContext
{
    const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
    const string RunName = "DP File Share";

    readonly string dir = AppDomain.CurrentDomain.BaseDirectory;
    readonly int adminPort;
    readonly NotifyIcon tray = new NotifyIcon();
    readonly Icon iconOn, iconOff;
    readonly ToolStripMenuItem shareItem, toggleItem, startupItem;
    readonly System.Windows.Forms.Timer poll = new System.Windows.Forms.Timer();
    readonly SynchronizationContext ui;
    Process server;
    StreamWriter logFile;
    bool on, busy, stopping;

    public TrayApp()
    {
        adminPort = ReadAdminPort();
        iconOn = MakeIcon(Color.FromArgb(22, 128, 61));
        iconOff = MakeIcon(Color.FromArgb(120, 126, 136));

        var menu = new ContextMenuStrip();
        ui = SynchronizationContext.Current; // set once the first control exists
        shareItem = new ToolStripMenuItem("Share files / create a link…", null, (s, e) => OpenManager());
        shareItem.Font = new Font(shareItem.Font, FontStyle.Bold);
        toggleItem = new ToolStripMenuItem("Turn on", null, (s, e) => Toggle());
        startupItem = new ToolStripMenuItem("Start with Windows", null, (s, e) => ToggleStartup());
        menu.Items.Add(shareItem);
        menu.Items.Add(toggleItem);
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add(startupItem);
        menu.Items.Add(new ToolStripMenuItem("Open DP File Share folder", null, (s, e) => Process.Start("explorer.exe", "\"" + dir.TrimEnd('\\') + "\"")));
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add(new ToolStripMenuItem("Exit", null, (s, e) => Quit()));
        menu.Opening += (s, e) => { Refresh(); startupItem.Checked = StartsWithWindows(); };

        tray.ContextMenuStrip = menu;
        tray.MouseClick += (s, e) => { if (e.Button == MouseButtons.Left) OpenManager(); };
        tray.Visible = true;
        SetOn(false);

        // Only a cheap local check, and only to notice sharing started or stopped elsewhere.
        poll.Interval = 15000;
        poll.Tick += (s, e) => Refresh();
        poll.Start();
        Refresh();
    }

    // ---------- state ----------

    void SetOn(bool value)
    {
        on = value;
        tray.Icon = on ? iconOn : iconOff;
        tray.Text = on ? "DP File Share: sharing is on" : "DP File Share: off";
        toggleItem.Text = on ? "Turn off" : "Turn on";
    }

    void Refresh()
    {
        if (busy) return;
        bool running = Api("GET", "/api/status", 1500) != null;
        if (running != on) SetOn(running);
    }

    // ---------- on / off ----------

    void Toggle()
    {
        if (on) TurnOff(true); else TurnOn(true);
    }

    bool TurnOn(bool announce)
    {
        if (Api("GET", "/api/status", 1500) != null) { SetOn(true); return true; }
        busy = true;
        try
        {
            string node = FindNode();
            if (node == null)
            {
                MessageBox.Show("Could not find Node.js. Install it from nodejs.org and try again.", "DP File Share", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return false;
            }
            var info = new ProcessStartInfo(node, "server.js")
            {
                WorkingDirectory = dir,
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
            };
            CloseLog();
            logFile = new StreamWriter(Path.Combine(dir, "server.log"), false, new UTF8Encoding(false)) { AutoFlush = true };
            server = new Process { StartInfo = info, EnableRaisingEvents = true };
            server.OutputDataReceived += (s, e) => WriteLog(e.Data);
            server.ErrorDataReceived += (s, e) => WriteLog(e.Data);
            server.Exited += OnServerExited;
            server.Start();
            server.BeginOutputReadLine();
            server.BeginErrorReadLine();

            for (int i = 0; i < 40; i++) // wait up to ~10 s for it to answer
            {
                if (server.HasExited) break;
                if (Api("GET", "/api/status", 500) != null)
                {
                    SetOn(true);
                    if (announce) tray.ShowBalloonTip(3000, "DP File Share is on", "Your links work now. Click the icon to share something.", ToolTipIcon.Info);
                    return true;
                }
                Thread.Sleep(250);
            }
            MessageBox.Show("DP File Share didn't start. Details are in server.log in the DP File Share folder.", "DP File Share", MessageBoxButtons.OK, MessageBoxIcon.Error);
            KillServer();
            return false;
        }
        finally { busy = false; }
    }

    // Returns false if the user chose to keep it running.
    bool TurnOff(bool ask)
    {
        string status = Api("GET", "/api/status", 1500);
        if (status == null && (server == null || server.HasExited)) { SetOn(false); return true; }
        var m = status == null ? null : Regex.Match(status, "\"activeTransfers\":(\\d+)");
        int transfers = m != null && m.Success ? int.Parse(m.Groups[1].Value) : 0;
        if (ask && transfers > 0)
        {
            var answer = MessageBox.Show(
                transfers + " download/upload" + (transfers == 1 ? " is" : "s are") + " in progress. Turning off stops " + (transfers == 1 ? "it" : "them") + ". Turn off anyway?",
                "DP File Share", MessageBoxButtons.YesNo, MessageBoxIcon.Warning, MessageBoxDefaultButton.Button2);
            if (answer != DialogResult.Yes) return false;
        }
        busy = true;
        stopping = true;
        try
        {
            Api("POST", "/api/shutdown", 3000);
            if (server != null && !server.HasExited && !server.WaitForExit(4000)) KillServer();
            for (int i = 0; i < 20 && Api("GET", "/api/status", 300) != null; i++) Thread.Sleep(150);
            SetOn(false);
            return true;
        }
        finally { busy = false; stopping = false; }
    }

    void OnServerExited(object sender, EventArgs e)
    {
        var proc = (Process)sender;
        int code = -1;
        try { code = proc.ExitCode; } catch { }
        bool unexpected = !stopping && !busy && code != 0;
        if (ui == null) return;
        ui.Post(delegate
        {
            if (proc != server) return;
            SetOn(false);
            if (unexpected) tray.ShowBalloonTip(5000, "DP File Share stopped", "It stopped unexpectedly. Details are in server.log.", ToolTipIcon.Warning);
        }, null);
    }

    void KillServer()
    {
        try { if (server != null && !server.HasExited) server.Kill(); } catch { }
    }

    void OpenManager()
    {
        if (!on && !TurnOn(false)) return;
        Process.Start(new ProcessStartInfo("http://127.0.0.1:" + adminPort + "/") { UseShellExecute = true });
    }

    void Quit()
    {
        if (on && !TurnOff(true)) return;
        poll.Stop();
        tray.Visible = false;
        CloseLog();
        ExitThread();
    }

    // ---------- start with Windows ----------

    string ExePath { get { return Application.ExecutablePath; } }

    bool StartsWithWindows()
    {
        using (var key = Registry.CurrentUser.OpenSubKey(RunKey))
        {
            var value = key == null ? null : key.GetValue(RunName) as string;
            return value != null && value.Trim('"').Equals(ExePath, StringComparison.OrdinalIgnoreCase);
        }
    }

    void ToggleStartup()
    {
        using (var key = Registry.CurrentUser.CreateSubKey(RunKey))
        {
            if (StartsWithWindows()) key.DeleteValue(RunName, false);
            else key.SetValue(RunName, "\"" + ExePath + "\"");
        }
    }

    // ---------- helpers ----------

    int ReadAdminPort()
    {
        try
        {
            var m = Regex.Match(File.ReadAllText(Path.Combine(dir, "config.json")), "\"adminPort\"\\s*:\\s*(\\d+)");
            if (m.Success) return int.Parse(m.Groups[1].Value);
        }
        catch { }
        return 53818;
    }

    string FindNode()
    {
        try
        {
            var m = Regex.Match(File.ReadAllText(Path.Combine(dir, "config.json")), "\"nodePath\"\\s*:\\s*\"([^\"]+)\"");
            if (m.Success) { string p = m.Groups[1].Value.Replace("\\\\", "\\"); if (File.Exists(p)) return p; }
        }
        catch { }
        foreach (var folder in (Environment.GetEnvironmentVariable("PATH") ?? "").Split(';'))
        {
            try
            {
                string p = Path.Combine(folder.Trim().Trim('"'), "node.exe");
                if (File.Exists(p)) return p;
            }
            catch { }
        }
        string def = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "nodejs", "node.exe");
        return File.Exists(def) ? def : null;
    }

    // Talks to the share manager on this PC. Returns the body, or null if it isn't running.
    string Api(string method, string path, int timeoutMs)
    {
        try
        {
            var req = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + adminPort + path);
            req.Method = method;
            req.Timeout = timeoutMs;
            req.ReadWriteTimeout = timeoutMs;
            req.Proxy = null;
            req.Headers["X-Requested-With"] = "fetch";
            if (method == "POST") { req.ContentType = "application/json"; req.ContentLength = 0; }
            using (var res = (HttpWebResponse)req.GetResponse())
            using (var reader = new StreamReader(res.GetResponseStream()))
                return reader.ReadToEnd();
        }
        catch { return null; }
    }

    readonly object logLock = new object();
    void WriteLog(string line)
    {
        if (line == null) return;
        lock (logLock) { try { if (logFile != null) logFile.WriteLine(line); } catch { } }
    }

    void CloseLog()
    {
        lock (logLock) { try { if (logFile != null) logFile.Dispose(); } catch { } logFile = null; }
    }

    [DllImport("user32.dll")] static extern bool DestroyIcon(IntPtr handle);

    // Draws the icon instead of shipping an .ico: a rounded square with "DP".
    static Icon MakeIcon(Color color)
    {
        int size = SystemInformation.SmallIconSize.Width * 2;
        if (size < 32) size = 32;
        using (var bmp = new Bitmap(size, size))
        using (var g = Graphics.FromImage(bmp))
        {
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.TextRenderingHint = TextRenderingHint.AntiAliasGridFit;
            float r = size * 0.22f;
            using (var shape = new GraphicsPath())
            {
                shape.AddArc(0, 0, r * 2, r * 2, 180, 90);
                shape.AddArc(size - r * 2 - 1, 0, r * 2, r * 2, 270, 90);
                shape.AddArc(size - r * 2 - 1, size - r * 2 - 1, r * 2, r * 2, 0, 90);
                shape.AddArc(0, size - r * 2 - 1, r * 2, r * 2, 90, 90);
                shape.CloseFigure();
                using (var brush = new SolidBrush(color)) g.FillPath(brush, shape);
            }
            using (var font = new Font("Segoe UI", size * 0.42f, FontStyle.Bold, GraphicsUnit.Pixel))
            using (var format = new StringFormat { Alignment = StringAlignment.Center, LineAlignment = StringAlignment.Center })
                g.DrawString("DP", font, Brushes.White, new RectangleF(0, 1, size, size), format);
            IntPtr h = bmp.GetHicon();
            var icon = (Icon)Icon.FromHandle(h).Clone();
            DestroyIcon(h);
            return icon;
        }
    }
}
