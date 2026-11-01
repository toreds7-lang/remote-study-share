// StudyShare setup. installer/build.ts compiles this file and SetupForm.cs with the C# compiler that
// comes with Windows (.NET Framework 4, C# 5) into two programs: StudyShare-Setup-<version>.exe, which
// carries the app as the embedded resource payload.zip, and uninstall.exe, the same program
// without it, which Apps & Features runs.
//
// Setup installs the app to Program Files\StudyShare for one of two roles: the teacher's PC (the
// server) or a 화면 공유 relay PC. Settings and class data live in %ProgramData%\StudyShare, which
// uninstalling keeps unless asked. StudyShare's two programs are allowed through Windows
// Firewall, and the role's shortcuts go to the Start menu.

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Windows.Forms;
using Microsoft.Win32;

class Options
{
    public bool Relay;
    public bool Desktop;
    /// <summary>Relay only: start the relay when someone signs in to Windows.</summary>
    public bool AutoStart;
    /// <summary>Relay only: the teacher's address and the relay key.</summary>
    public string Origin, Key;
    /// <summary>Teacher only: a project folder that ran run.bat, whose class data and settings to copy, or null.</summary>
    public string ImportFrom;
}

static partial class Setup
{
    public static readonly string InstallDir = Path.Combine(Folder(Environment.SpecialFolder.ProgramFiles), "StudyShare");
    public static readonly string HomeDir = Path.Combine(Folder(Environment.SpecialFolder.CommonApplicationData), "StudyShare");
    const string UninstallKey = @"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\StudyShare";

    [STAThread]
    static void Main()
    {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        Stream payload = typeof(Setup).Assembly.GetManifestResourceStream("payload.zip");
        if (payload == null) Uninstall(Path.GetDirectoryName(Application.ExecutablePath));
        else Application.Run(new SetupForm(payload));
    }

    // ---- install ----

    /// <summary>Installs everything. report gets a status line and a percentage. Returns a line about the firewall.</summary>
    public static string Install(Options o, Stream payload, Action<string, int> report)
    {
        long bytes = Extract(payload, InstallDir, pct => report("파일을 복사하는 중…", pct * 85 / 100));

        report("설정을 만드는 중…", 85);
        PrepareHome(HomeDir);
        if (o.Relay) RelaySettings(HomeDir, Path.Combine(InstallDir, "relay.example.txt"), o.Origin, o.Key);
        else TeacherSettings(HomeDir, Path.Combine(InstallDir, "env.example.txt"), o.ImportFrom);

        report("방화벽을 여는 중…", 90);
        string firewall;
        try
        {
            firewall = Firewall.Allow(InstallDir)
                ? "⚠ 연결된 네트워크 중 '공용'이 있어요. 공용 네트워크에서는 방화벽 허용이 적용되지 않아요. Windows 설정 → 네트워크 및 인터넷 → 속성에서 '개인 네트워크'로 바꾸거나 IT 담당자에게 문의하세요."
                : "방화벽: StudyShare 프로그램을 도메인·개인 네트워크에서 허용했어요. 그래도 다른 PC에서 접속하지 못하면 회사 방화벽 정책이 막는 것일 수 있어요. IT 담당자에게 문의하세요.";
        }
        catch (Exception e)
        {
            firewall = "⚠ 방화벽을 설정하지 못했어요 (" + e.Message + "). IT 담당자에게 " + InstallDir +
                "의 node.exe와 mediasoup-worker.exe를 허용해 달라고 요청하세요.";
        }

        report("바로 가기를 만드는 중…", 95);
        Shortcuts(o);
        Register(o, bytes);
        report("다 됐어요.", 100);
        return firewall;
    }

    /// <summary>Unpacks the payload into dir, replacing the folders an earlier version installed. Returns the bytes written.</summary>
    public static long Extract(Stream payload, string dir, Action<int> progress)
    {
        foreach (string sub in new[] { "dist", "server", "node_modules" })
        {
            string path = Path.Combine(dir, sub);
            if (Directory.Exists(path)) Directory.Delete(path, true);
        }
        payload.Position = 0;
        using (var zip = new ZipArchive(payload, ZipArchiveMode.Read, true))
        {
            long total = Math.Max(zip.Entries.Sum(e => e.Length), 1), done = 0;
            foreach (ZipArchiveEntry entry in zip.Entries)
            {
                string target = Path.Combine(dir, entry.FullName.Replace('/', '\\'));
                Directory.CreateDirectory(Path.GetDirectoryName(target));
                using (Stream from = entry.Open())
                using (FileStream to = File.Create(target))
                    from.CopyTo(to);
                done += entry.Length;
                progress((int)(done * 100 / total));
            }
            return total;
        }
    }

    /// <summary>Makes the settings and data folder writable for every user: the server runs as whoever signs in, not as the admin who installed it.</summary>
    static void PrepareHome(string home)
    {
        DirectoryInfo dir = Directory.CreateDirectory(home);
        DirectorySecurity acl = dir.GetAccessControl();
        acl.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(WellKnownSidType.BuiltinUsersSid, null),
            FileSystemRights.Modify, InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit,
            PropagationFlags.None, AccessControlType.Allow));
        dir.SetAccessControl(acl);
    }

    // ---- settings files (KEY=value lines, read by server/config.ts or node --env-file) ----

    /// <summary>
    /// Writes env.txt from the template the first time. With importFrom (a project folder that ran
    /// run.bat), its class data is copied in and its settings replace the template's values.
    /// </summary>
    public static void TeacherSettings(string home, string template, string importFrom)
    {
        string file = Path.Combine(home, "env.txt");
        if (File.Exists(file) && importFrom == null) return;
        List<string> lines = File.ReadAllLines(File.Exists(file) ? file : template).ToList();
        if (importFrom != null)
        {
            Dictionary<string, string> old = OldSettings(importFrom);
            CopyDir(OldDataDir(importFrom, old), Path.Combine(home, "data"));
            foreach (KeyValuePair<string, string> kv in old)
                if (kv.Key != "DATA_DIR") SetEnv(lines, kv.Key, kv.Value);
        }
        WriteLines(file, lines);
    }

    /// <summary>Writes the teacher's address and the relay key into relay.txt, keeping its other settings.</summary>
    public static void RelaySettings(string home, string template, string origin, string key)
    {
        string file = Path.Combine(home, "relay.txt");
        List<string> lines = File.ReadAllLines(File.Exists(file) ? file : template).ToList();
        SetEnv(lines, "ORIGIN", origin);
        SetEnv(lines, "RELAY_KEY", key);
        WriteLines(file, lines);
    }

    /// <summary>Why dir can't be imported, or null.</summary>
    public static string CheckImport(string dir)
    {
        if (dir == "" || !Directory.Exists(dir)) return "가져올 폴더를 고르세요.";
        string db = Path.Combine(OldDataDir(dir, OldSettings(dir)), "study.db");
        if (!File.Exists(db)) return "이 폴더에서 수업 자료(" + db + ")를 찾지 못했어요. run.bat이 있는 StudyShare 폴더를 고르세요.";
        return null;
    }

    /// <summary>A project folder's settings: env.txt, then .env, which wins as in server/config.ts.</summary>
    static Dictionary<string, string> OldSettings(string dir)
    {
        Dictionary<string, string> values = ReadEnv(Path.Combine(dir, "env.txt"));
        foreach (KeyValuePair<string, string> kv in ReadEnv(Path.Combine(dir, ".env"))) values[kv.Key] = kv.Value;
        return values;
    }

    static string OldDataDir(string dir, Dictionary<string, string> settings)
    {
        string data;
        settings.TryGetValue("DATA_DIR", out data);
        data = (data ?? "").Trim('"', '\'');
        return Path.Combine(dir, data == "" ? "data" : data);
    }

    /// <summary>The KEY=value lines of an env file, without comments and blank lines.</summary>
    public static Dictionary<string, string> ReadEnv(string file)
    {
        var values = new Dictionary<string, string>();
        if (!File.Exists(file)) return values;
        foreach (string line in File.ReadAllLines(file))
        {
            string t = line.Trim();
            int eq = t.IndexOf('=');
            if (t.StartsWith("#") || eq < 1) continue;
            values[t.Substring(0, eq).Trim()] = t.Substring(eq + 1).Trim();
        }
        return values;
    }

    /// <summary>Sets KEY=value on the line that has the key, or adds a line.</summary>
    public static void SetEnv(List<string> lines, string key, string value)
    {
        int i = lines.FindIndex(l => l.TrimStart().StartsWith(key + "="));
        if (i >= 0) lines[i] = key + "=" + value;
        else lines.Add(key + "=" + value);
    }

    static void WriteLines(string file, List<string> lines)
    {
        // Without a BOM, which Node would read as part of the first line.
        File.WriteAllLines(file, lines, new UTF8Encoding(false));
    }

    static void CopyDir(string from, string to)
    {
        Directory.CreateDirectory(to);
        foreach (string f in Directory.GetFiles(from)) File.Copy(f, Path.Combine(to, Path.GetFileName(f)), true);
        foreach (string d in Directory.GetDirectories(from)) CopyDir(d, Path.Combine(to, Path.GetFileName(d)));
    }

    // ---- shortcuts and Apps & Features ----

    public static string MainName(bool relay) { return relay ? "StudyShare 릴레이" : "StudyShare"; }

    /// <summary>The Start menu shortcut that starts the role's program.</summary>
    public static string MainShortcut(bool relay) { return Path.Combine(StartMenu, MainName(relay) + ".lnk"); }

    static string StartMenu { get { return Path.Combine(Folder(Environment.SpecialFolder.CommonPrograms), "StudyShare"); } }

    static void Shortcuts(Options o)
    {
        RemoveShortcuts();
        string name = MainName(o.Relay);
        string program = Path.Combine(InstallDir, o.Relay ? "StudyShare-Relay.cmd" : "StudyShare.cmd");
        string icon = Path.Combine(InstallDir, "StudyShare.ico");
        string settings = Path.Combine(HomeDir, o.Relay ? "relay.txt" : "env.txt");
        string about = o.Relay ? "강사 화면을 받아 일부 학생에게 대신 보내요." : "StudyShare 서버를 켜고 브라우저를 열어요.";
        Link(MainShortcut(o.Relay), program, "", icon, about);
        Link(Path.Combine(StartMenu, name + " 설정.lnk"), Path.Combine(Environment.SystemDirectory, "notepad.exe"), Quote(settings), null, settings);
        if (o.Desktop) Link(Path.Combine(Folder(Environment.SpecialFolder.CommonDesktopDirectory), name + ".lnk"), program, "", icon, about);
        if (o.AutoStart) Link(Path.Combine(Folder(Environment.SpecialFolder.CommonStartup), name + ".lnk"), program, "", icon, about);
    }

    /// <summary>Both roles' shortcuts, so that switching the role leaves no stale ones.</summary>
    static void RemoveShortcuts()
    {
        if (Directory.Exists(StartMenu)) Directory.Delete(StartMenu, true);
        foreach (bool relay in new[] { false, true })
            foreach (Environment.SpecialFolder f in new[] { Environment.SpecialFolder.CommonDesktopDirectory, Environment.SpecialFolder.CommonStartup })
                File.Delete(Path.Combine(Folder(f), MainName(relay) + ".lnk"));
    }

    public static void Link(string lnk, string target, string args, string icon, string description)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(lnk));
        var link = (IShellLinkW)new ShellLink();
        link.SetPath(target);
        link.SetArguments(args);
        link.SetWorkingDirectory(Path.GetDirectoryName(target));
        link.SetDescription(description);
        if (icon != null) link.SetIconLocation(icon, 0);
        ((IPersistFile)link).Save(lnk, true);
        Marshal.ReleaseComObject(link);
    }

    static void Register(Options o, long bytes)
    {
        using (RegistryKey k = Registry.LocalMachine.CreateSubKey(UninstallKey))
        {
            k.SetValue("DisplayName", o.Relay ? "StudyShare (릴레이 PC)" : "StudyShare");
            k.SetValue("DisplayVersion", Version);
            k.SetValue("Publisher", "StudyShare");
            k.SetValue("DisplayIcon", Path.Combine(InstallDir, "StudyShare.ico"));
            k.SetValue("InstallLocation", InstallDir);
            k.SetValue("UninstallString", Quote(Path.Combine(InstallDir, "uninstall.exe")));
            k.SetValue("NoModify", 1, RegistryValueKind.DWord);
            k.SetValue("NoRepair", 1, RegistryValueKind.DWord);
            k.SetValue("EstimatedSize", (int)(bytes / 1024), RegistryValueKind.DWord);
            k.SetValue("Role", o.Relay ? "relay" : "teacher");
        }
    }

    /// <summary>The role of the current install, to offer it again: "teacher", "relay" or null.</summary>
    public static string InstalledRole()
    {
        using (RegistryKey k = Registry.LocalMachine.OpenSubKey(UninstallKey))
            return k == null ? null : k.GetValue("Role") as string;
    }

    // ---- running copies ----

    /// <summary>StudyShare's programs running from dir: the server or relay, and the media worker.</summary>
    static List<Process> Running(string dir)
    {
        var found = new List<Process>();
        foreach (string name in new[] { "node", "mediasoup-worker" })
            foreach (Process p in Process.GetProcessesByName(name))
            {
                try
                {
                    if (p.MainModule.FileName.StartsWith(dir + "\\", StringComparison.OrdinalIgnoreCase)) found.Add(p);
                }
                catch (Exception)
                {
                    // It exited meanwhile, or it isn't ours to inspect.
                }
            }
        return found;
    }

    /// <summary>Its files can't be replaced or deleted while StudyShare runs: asks, then ends it. False = keep it running.</summary>
    public static bool StopRunning(string dir, IWin32Window owner)
    {
        List<Process> running = Running(dir);
        if (running.Count == 0) return true;
        if (MessageBox.Show(owner, "StudyShare가 실행 중이에요. 끄고 계속할까요?", "StudyShare",
            MessageBoxButtons.OKCancel, MessageBoxIcon.Warning) != DialogResult.OK) return false;
        foreach (Process p in running)
        {
            try
            {
                p.Kill();
                p.WaitForExit(5000);
            }
            catch (Exception)
            {
                // Already gone.
            }
        }
        return true;
    }

    // ---- uninstall ----

    static void Uninstall(string dir)
    {
        const string title = "StudyShare 제거";
        // Only a folder setup made; uninstall.exe deletes the folder it is in.
        if (!File.Exists(Path.Combine(dir, "StudyShare.cmd"))) return;
        if (MessageBox.Show("StudyShare를 이 PC에서 제거할까요?", title, MessageBoxButtons.YesNo, MessageBoxIcon.Question) != DialogResult.Yes) return;
        if (!StopRunning(dir, null)) return;
        try
        {
            Firewall.Remove(dir);
        }
        catch (Exception)
        {
            // The rules name programs that are about to be deleted, so they allow nothing anyway.
        }
        RemoveShortcuts();
        Registry.LocalMachine.DeleteSubKeyTree(UninstallKey, false);
        if (Directory.Exists(HomeDir) && MessageBox.Show(
            "수업 자료와 설정도 지울까요?\n\n" + HomeDir + "\n\n'아니요'를 누르면 남겨 둬요. 다시 설치하면 그대로 이어서 쓸 수 있어요.",
            title, MessageBoxButtons.YesNo, MessageBoxIcon.Question, MessageBoxDefaultButton.Button2) == DialogResult.Yes)
        {
            try
            {
                Directory.Delete(HomeDir, true);
            }
            catch (Exception e)
            {
                MessageBox.Show("일부를 지우지 못했어요: " + e.Message + "\n\n" + HomeDir + " 폴더를 직접 지우세요.", title);
            }
        }
        MessageBox.Show("StudyShare를 제거했어요.", title);
        // This program is in the folder, so cmd deletes it once this process has exited.
        Process.Start(new ProcessStartInfo(Path.Combine(Environment.SystemDirectory, "cmd.exe"),
            "/c ping -n 3 127.0.0.1 >nul & rmdir /s /q " + Quote(dir))
        {
            WorkingDirectory = Path.GetTempPath(),
            CreateNoWindow = true,
            UseShellExecute = false,
        });
    }

    // ---- helpers ----

    static string Folder(Environment.SpecialFolder f) { return Environment.GetFolderPath(f); }

    public static string Quote(string s) { return "\"" + s + "\""; }

    [ComImport, Guid("00021401-0000-0000-C000-000000000046")]
    class ShellLink { }

    [ComImport, Guid("000214F9-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IShellLinkW
    {
        void GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder file, int max, IntPtr data, int flags);
        void GetIDList(out IntPtr idl);
        void SetIDList(IntPtr idl);
        void GetDescription([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder name, int max);
        void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string name);
        void GetWorkingDirectory([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder dir, int max);
        void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string dir);
        void GetArguments([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder args, int max);
        void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string args);
        void GetHotkey(out short key);
        void SetHotkey(short key);
        void GetShowCmd(out int cmd);
        void SetShowCmd(int cmd);
        void GetIconLocation([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder path, int max, out int index);
        void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string path, int index);
        void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string path, int reserved);
        void Resolve(IntPtr hwnd, int flags);
        void SetPath([MarshalAs(UnmanagedType.LPWStr)] string file);
    }
}

/// <summary>
/// Windows Firewall rules for StudyShare's two programs: node.exe serves the page (and is the relay
/// on a relay PC), and mediasoup-worker.exe sends the shared screen. Rules for the programs rather
/// than for ports keep working when PORT or SCREEN_PORT changes. Domain and private networks only.
/// </summary>
static class Firewall
{
    const string Group = "StudyShare";
    const int Inbound = 1, ActionBlock = 0, ActionAllow = 1, AnyProtocol = 256, DomainAndPrivate = 1 | 2, PublicProfile = 4;

    /// <summary>Adds the rules, replacing earlier ones. True when a connected network is public, where they don't apply.</summary>
    public static bool Allow(string dir)
    {
        dynamic policy = Policy();
        Remove(policy, dir);
        Add(policy, "StudyShare: server", "The StudyShare page, and the relay on relay PCs.", Path.Combine(dir, "node.exe"));
        Add(policy, "StudyShare: screen sharing", "StudyShare 화면 공유 to students and relay PCs.", Path.Combine(dir, "mediasoup-worker.exe"));
        return (policy.CurrentProfileTypes & PublicProfile) != 0;
    }

    public static void Remove(string dir) { Remove(Policy(), dir); }

    static dynamic Policy() { return Activator.CreateInstance(Type.GetTypeFromProgID("HNetCfg.FwPolicy2")); }

    static void Add(dynamic policy, string name, string description, string program)
    {
        dynamic rule = Activator.CreateInstance(Type.GetTypeFromProgID("HNetCfg.FWRule"));
        rule.Name = name;
        rule.Description = description;
        rule.Grouping = Group;
        rule.ApplicationName = program;
        rule.Protocol = AnyProtocol;
        rule.Direction = Inbound;
        rule.Action = ActionAllow;
        rule.Profiles = DomainAndPrivate;
        rule.Enabled = true;
        policy.Rules.Add(rule);
    }

    /// <summary>
    /// Removes our rules and any block rule on our programs. Windows makes those when its "allow
    /// access" prompt is closed without allowing, and a block rule wins over an allow rule.
    /// </summary>
    static void Remove(dynamic policy, string dir)
    {
        var doomed = new List<object>();
        foreach (dynamic rule in policy.Rules)
        {
            string program = rule.ApplicationName ?? "";
            if (rule.Grouping == Group || (rule.Action == ActionBlock && program.StartsWith(dir + "\\", StringComparison.OrdinalIgnoreCase)))
                doomed.Add(rule);
        }
        // Rules are removed by name, and Windows' block rules share theirs with other copies of Node.
        foreach (dynamic rule in doomed)
        {
            string name = "StudyShare-remove-" + Guid.NewGuid().ToString("N");
            rule.Name = name;
            policy.Rules.Remove(name);
        }
    }
}
