// DP File Share: the program people run. It sits in the tray and does next to nothing until
// sharing is turned on. Then it unpacks the server (the "engine", carried inside this exe) and
// runs it in the background. Build with build.ps1.

using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Text;
using System.IO;
using System.IO.Compression;
using System.Net;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

static class Program
{
    const string OpenSignal = "DPFileShareOpen";

    [STAThread]
    static void Main(string[] args)
    {
        // Windows starts us with --startup at sign-in: stay quiet in the tray. Started by hand,
        // open the share manager straight away.
        bool quiet = Array.IndexOf(args, "--startup") >= 0;
        bool first;
        using (var mutex = new Mutex(true, "DPFileShareTray", out first))
        {
            if (!first)
            {
                // Already in the tray: ask that copy to open the share manager instead.
                if (!quiet) try { EventWaitHandle.OpenExisting(OpenSignal).Set(); } catch { }
                return;
            }
            using (var open = new EventWaitHandle(false, EventResetMode.AutoReset, OpenSignal))
            {
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                Application.Run(new TrayApp(!quiet, open));
            }
        }
    }
}

class TrayApp : ApplicationContext
{
    const string AppName = "DP File Share";
    const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
    const string ProjectUrl = "https://github.com/digitaldpp/dpfileshare";

    readonly string exeDir = AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\');
    readonly string localDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), AppName);
    readonly string dataDir;
    readonly bool portable;
    readonly int adminPort;
    readonly NotifyIcon tray = new NotifyIcon();
    readonly Icon iconOn, iconOff;
    readonly ToolStripMenuItem shareItem, toggleItem, startupItem;
    readonly System.Windows.Forms.Timer poll = new System.Windows.Forms.Timer();
    readonly SynchronizationContext ui;
    Process server;
    StreamWriter logFile;
    string lastLogLine;
    bool on, busy, stopping;

    public TrayApp(bool openNow, EventWaitHandle openSignal)
    {
        // Settings, links and the certificate normally live in the user's AppData folder. If a
        // config.json or links.json sits next to the exe, that folder is used instead (portable).
        portable = File.Exists(Path.Combine(exeDir, "config.json")) || File.Exists(Path.Combine(exeDir, "links.json"));
        dataDir = portable ? exeDir : localDir;
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
        menu.Items.Add(new ToolStripMenuItem("Open settings and log folder", null, (s, e) => OpenFolder(dataDir)));
        menu.Items.Add(new ToolStripMenuItem("About " + AppName + " " + Application.ProductVersion, null, (s, e) => OpenUrl(ProjectUrl)));
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

        // Running the exe again while it is already in the tray opens the share manager.
        var waiter = new Thread(() =>
        {
            while (true)
            {
                try { openSignal.WaitOne(); } catch { return; }
                ui.Post(delegate { OpenManager(); }, null);
            }
        });
        waiter.IsBackground = true;
        waiter.Start();

        if (openNow)
        {
            var once = new System.Windows.Forms.Timer { Interval = 50 };
            once.Tick += (s, e) =>
            {
                once.Stop();
                once.Dispose();
                tray.ShowBalloonTip(4000, AppName, "It lives here in the tray. Click the icon to share files; right-click for more.", ToolTipIcon.Info);
                OpenManager();
            };
            once.Start();
        }
    }

    // ---------- state ----------

    void SetOn(bool value)
    {
        on = value;
        tray.Icon = on ? iconOn : iconOff;
        tray.Text = on ? AppName + ": sharing is on" : AppName + ": off";
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
            ProcessStartInfo info;
            try { info = EngineCommand(); }
            catch (Exception ex)
            {
                Error("Could not get " + AppName + " ready to run.\n\n" + ex.Message);
                return false;
            }
            if (info == null)
            {
                Error("This is a development build with no engine inside it, and Node.js could not be found to run server.js. Install Node.js, or build the full app with build.ps1.");
                return false;
            }
            Directory.CreateDirectory(dataDir);
            info.WorkingDirectory = dataDir;
            info.UseShellExecute = false;
            info.CreateNoWindow = true;
            info.RedirectStandardOutput = true;
            info.RedirectStandardError = true;
            info.EnvironmentVariables["DPFS_DATA_DIR"] = dataDir;
            info.EnvironmentVariables["DPFS_PARENT_PID"] = Process.GetCurrentProcess().Id.ToString();
            if (!portable) info.EnvironmentVariables["DPFS_DEFAULT_UPLOAD_DIR"] = Path.Combine(DownloadsFolder(), AppName);
            info.EnvironmentVariables.Remove("NODE_OPTIONS"); // a developer's Node settings must not leak in
            info.EnvironmentVariables.Remove("PORT");
            info.EnvironmentVariables.Remove("ADMIN_PORT");

            CloseLog();
            lastLogLine = null;
            logFile = new StreamWriter(LogPath, false, new UTF8Encoding(false)) { AutoFlush = true };
            server = new Process { StartInfo = info, EnableRaisingEvents = true };
            server.OutputDataReceived += (s, e) => WriteLog(e.Data);
            server.ErrorDataReceived += (s, e) => WriteLog(e.Data);
            server.Exited += OnServerExited;
            server.Start();
            server.BeginOutputReadLine();
            server.BeginErrorReadLine();

            for (int i = 0; i < 60; i++) // wait up to ~15 s for it to answer
            {
                if (server.HasExited) break;
                if (Api("GET", "/api/status", 500) != null)
                {
                    SetOn(true);
                    if (announce) tray.ShowBalloonTip(3000, AppName + " is on", "Your links work now. Click the icon to share something.", ToolTipIcon.Info);
                    return true;
                }
                Thread.Sleep(250);
            }
            KillServer();
            Thread.Sleep(200); // let the last lines of output arrive
            Error(AppName + " didn't start." + (lastLogLine == null ? "" : "\n\n" + lastLogLine) + "\n\nThe full log is at " + LogPath);
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
                AppName, MessageBoxButtons.YesNo, MessageBoxIcon.Warning, MessageBoxDefaultButton.Button2);
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
            if (unexpected) tray.ShowBalloonTip(5000, AppName + " stopped", "It stopped unexpectedly. Details are in server.log (right-click the icon, then open the settings and log folder).", ToolTipIcon.Warning);
        }, null);
    }

    void KillServer()
    {
        try { if (server != null && !server.HasExited) server.Kill(); } catch { }
    }

    void OpenManager()
    {
        if (!on && !TurnOn(false)) return;
        OpenUrl("http://127.0.0.1:" + adminPort + "/");
    }

    void Quit()
    {
        if (on && !TurnOff(true)) return;
        poll.Stop();
        tray.Visible = false;
        CloseLog();
        ExitThread();
    }

    // ---------- the engine ----------

    // How to start the server. The full app carries it at the end of this exe, compressed, and unpacks
    // it once per version into the user's AppData folder. A development build without one runs
    // server.js from the exe's folder with Node.js. Returns null if neither is possible.
    ProcessStartInfo EngineCommand()
    {
        var asm = Assembly.GetExecutingAssembly();
        string id;
        using (var s = asm.GetManifestResourceStream("engine.id"))
        {
            if (s == null)
            {
                string node = FindNode();
                string script = Path.Combine(exeDir, "server.js");
                return node != null && File.Exists(script) ? new ProcessStartInfo(node, "\"" + script + "\"") : null;
            }
            using (var reader = new StreamReader(s)) id = reader.ReadToEnd().Trim();
        }

        string engineDir = Path.Combine(localDir, "engine");
        string exe = Path.Combine(engineDir, "dpfs-engine.exe");
        string idFile = Path.Combine(engineDir, "engine.id");
        bool current = false;
        try { current = File.Exists(exe) && File.ReadAllText(idFile).Trim() == id; } catch { }
        if (!current)
        {
            Directory.CreateDirectory(engineDir);
            string fresh = exe + ".new";
            UnpackEngine(fresh);
            File.Delete(idFile);
            File.Delete(exe);
            File.Move(fresh, exe);
            File.WriteAllText(idFile, id);
        }
        return new ProcessStartInfo(exe);
    }

    // The compressed engine is stored after the end of the program itself, followed by its
    // length and a marker. Kept there (not as a .NET resource) so that Windows doesn't load
    // all of it into memory just to show the tray icon.
    void UnpackEngine(string target)
    {
        using (var self = new FileStream(ExePath, FileMode.Open, FileAccess.Read, FileShare.Read))
        {
            var tail = new byte[16];
            self.Seek(-16, SeekOrigin.End);
            self.Read(tail, 0, 16);
            long length = BitConverter.ToInt64(tail, 0);
            if (Encoding.ASCII.GetString(tail, 8, 8) != "DPFSENG1" || length <= 0 || length > self.Length - 16)
                throw new InvalidDataException("This copy of the program is incomplete or damaged. Download it again.");
            self.Seek(-16 - length, SeekOrigin.End);
            var packed = new byte[length];
            for (int got = 0; got < packed.Length; )
            {
                int n = self.Read(packed, got, packed.Length - got);
                if (n <= 0) throw new EndOfStreamException();
                got += n;
            }
            using (var unzip = new GZipStream(new MemoryStream(packed), CompressionMode.Decompress))
            using (var file = File.Create(target))
                unzip.CopyTo(file);
            packed = null;
            GC.Collect(); // hand those 30 MB straight back
        }
    }

    string FindNode()
    {
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

    // ---------- start with Windows ----------

    string ExePath { get { return Application.ExecutablePath; } }

    bool StartsWithWindows()
    {
        using (var key = Registry.CurrentUser.OpenSubKey(RunKey))
        {
            var value = key == null ? null : key.GetValue(AppName) as string;
            if (value == null) return false;
            return value.StartsWith("\"" + ExePath + "\"", StringComparison.OrdinalIgnoreCase)
                || value.Equals(ExePath, StringComparison.OrdinalIgnoreCase);
        }
    }

    void ToggleStartup()
    {
        using (var key = Registry.CurrentUser.CreateSubKey(RunKey))
        {
            if (StartsWithWindows()) key.DeleteValue(AppName, false);
            else key.SetValue(AppName, "\"" + ExePath + "\" --startup");
        }
    }

    // ---------- helpers ----------

    string LogPath { get { return Path.Combine(dataDir, "server.log"); } }

    void Error(string message)
    {
        MessageBox.Show(message, AppName, MessageBoxButtons.OK, MessageBoxIcon.Error);
    }

    void OpenUrl(string url)
    {
        try { Process.Start(new ProcessStartInfo(url) { UseShellExecute = true }); } catch { }
    }

    void OpenFolder(string folder)
    {
        try
        {
            Directory.CreateDirectory(folder);
            Process.Start("explorer.exe", "\"" + folder + "\"");
        }
        catch { }
    }

    int ReadAdminPort()
    {
        try
        {
            var m = Regex.Match(File.ReadAllText(Path.Combine(dataDir, "config.json")), "\"adminPort\"\\s*:\\s*(\\d+)");
            if (m.Success) return int.Parse(m.Groups[1].Value);
        }
        catch { }
        return 53818;
    }

    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    static extern int SHGetKnownFolderPath([MarshalAs(UnmanagedType.LPStruct)] Guid id, uint flags, IntPtr token, out IntPtr path);

    static string DownloadsFolder()
    {
        IntPtr p;
        if (SHGetKnownFolderPath(new Guid("374DE290-123F-4565-9164-39C4925E467B"), 0, IntPtr.Zero, out p) == 0)
        {
            string path = Marshal.PtrToStringUni(p);
            Marshal.FreeCoTaskMem(p);
            if (!string.IsNullOrEmpty(path)) return path;
        }
        return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "Downloads");
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
        lock (logLock)
        {
            if (line.Trim().Length > 0) lastLogLine = line;
            try { if (logFile != null) logFile.WriteLine(line); } catch { }
        }
    }

    void CloseLog()
    {
        lock (logLock) { try { if (logFile != null) logFile.Dispose(); } catch { } logFile = null; }
    }

    [DllImport("user32.dll")] static extern bool DestroyIcon(IntPtr handle);

    // The tray icon is drawn, so it can change colour: a rounded square with "DP".
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
