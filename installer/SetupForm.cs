// The setup window: pick the role (and the relay's address and key), install, then a summary.

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;

class SetupForm : Form
{
    readonly Stream payload;
    readonly Panel options = Page(), progress = Page(), done = Page();
    readonly RadioButton teacher = new RadioButton(), relay = new RadioButton();
    readonly GroupBox teacherBox = Box("강사 PC"), relayBox = Box("릴레이 PC");
    readonly CheckBox import = new CheckBox(), autoStart = new CheckBox(), desktop = new CheckBox(), launch = new CheckBox();
    readonly TextBox importDir = new TextBox(), origin = new TextBox(), key = new TextBox();
    readonly Button browse = new Button(), next = new Button(), cancel = new Button();
    readonly Label status = new Label(), summary = new Label();
    readonly ProgressBar bar = new ProgressBar();
    bool installing, installedRelay;

    /// <summary>Content width at 96 dpi.</summary>
    const int Wide = 520;

    /// <summary>Screen pixels per 96-dpi pixel. Sizes are scaled by hand: WinForms' own scaling misses MinimumSize and MaximumSize.</summary>
    static readonly float Dpi = DpiScale();

    public SetupForm(Stream payload)
    {
        this.payload = payload;
        SuspendLayout();
        AutoScaleMode = AutoScaleMode.None;
        Font = SystemFonts.MessageBoxFont;
        Text = "StudyShare 설치";
        Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = MinimizeBox = false;
        StartPosition = FormStartPosition.CenterScreen;
        ClientSize = new Size(S(Wide + 40), S(510));

        var header = new Panel { Dock = DockStyle.Top, Height = S(64), BackColor = SystemColors.Window };
        header.Controls.Add(new Label
        {
            Text = "StudyShare " + Setup.Version,
            Font = new Font(Font.FontFamily, 13F, FontStyle.Bold),
            AutoSize = true,
            Location = new Point(S(18), S(10)),
        });
        header.Controls.Add(new Label { Text = Setup.InstallDir + "에 설치해요.", AutoSize = true, ForeColor = SystemColors.GrayText, Location = new Point(S(20), S(40)) });
        var rule = new Label { Dock = DockStyle.Top, Height = 1, BackColor = SystemColors.ControlDark };

        var footer = new FlowLayoutPanel { Dock = DockStyle.Bottom, Height = S(50), FlowDirection = FlowDirection.RightToLeft, Padding = P(12, 10, 12, 0) };
        cancel.Text = "취소";
        next.Text = "설치";
        foreach (Button b in new[] { cancel, next })
        {
            b.Size = new Size(S(96), S(28));
            footer.Controls.Add(b);
        }
        next.Click += OnNext;
        cancel.Click += delegate { Close(); };
        AcceptButton = next;
        CancelButton = cancel;

        var body = new Panel { Dock = DockStyle.Fill, Padding = P(20, 14, 20, 0) };
        BuildOptions();
        BuildProgress();
        BuildDone();
        body.Controls.AddRange(new Control[] { options, progress, done });
        ShowPage(options);

        // Docking goes from the back: header, then the rule under it, the footer, and the body in what is left.
        Controls.AddRange(new Control[] { footer, rule, header, body });
        body.BringToFront();
        ResumeLayout(false);
        PerformLayout();
    }

    void BuildOptions()
    {
        FlowLayoutPanel col = Column();
        col.Controls.Add(Note("이 PC에서 할 일을 고르세요.", false));
        teacher.Text = "강사 PC — 수업 서버";
        relay.Text = "릴레이 PC — 남는 PC로 화면 공유 나눠 보내기";
        foreach (RadioButton r in new[] { teacher, relay })
        {
            r.AutoSize = true;
            r.Margin = P(0, 8, 0, 0);
            r.CheckedChanged += delegate { teacherBox.Visible = teacher.Checked; relayBox.Visible = relay.Checked; };
        }
        col.Controls.Add(teacher);
        col.Controls.Add(Note("교안과 화면 공유를 열어요. 학생들은 이 PC 주소로 접속해요.", true, 18));
        col.Controls.Add(relay);
        col.Controls.Add(Note("강사 화면을 한 번 받아, 서버가 이 PC에 배정한 학생들에게 대신 보내요.", true, 18));

        // Teacher: carry over the data of a run.bat project folder, unless this PC already has data.
        FlowLayoutPanel t = Column();
        if (File.Exists(Path.Combine(Setup.HomeDir, "data", "study.db")))
        {
            t.Controls.Add(Note(Setup.HomeDir + "에 있는 수업 자료와 설정을 그대로 이어서 써요.", true));
        }
        else
        {
            import.Text = "run.bat으로 쓰던 폴더에서 수업 자료와 설정 가져오기";
            import.AutoSize = true;
            importDir.Width = S(Wide - 170);
            importDir.Enabled = browse.Enabled = false;
            import.CheckedChanged += delegate { importDir.Enabled = browse.Enabled = import.Checked; };
            browse.Text = "찾아보기…";
            browse.Size = new Size(S(88), importDir.PreferredHeight + 2);
            browse.Click += OnBrowse;
            var row = new FlowLayoutPanel { AutoSize = true, WrapContents = false, Margin = P(16, 4, 0, 0) };
            row.Controls.Add(importDir);
            row.Controls.Add(browse);
            t.Controls.Add(import);
            t.Controls.Add(row);
            t.Controls.Add(Note("그 폴더의 run.bat 창을 먼저 닫으세요. 원래 폴더는 그대로 둬요.", true, 18));
        }
        teacherBox.Controls.Add(t);

        // Relay: the teacher's address and the relay key, from this PC's earlier install if any.
        Dictionary<string, string> saved = Setup.ReadEnv(Path.Combine(Setup.HomeDir, "relay.txt"));
        string value;
        if (saved.TryGetValue("ORIGIN", out value)) origin.Text = value;
        if (saved.TryGetValue("RELAY_KEY", out value)) key.Text = value;
        origin.HandleCreated += delegate { Cue(origin, "http://10.0.0.5:3000"); };
        var grid = new TableLayoutPanel { AutoSize = true, ColumnCount = 2, Margin = P(0, 0, 0, 0) };
        foreach (TextBox box in new[] { origin, key })
        {
            grid.Controls.Add(new Label { Text = box == origin ? "강사 PC 주소" : "릴레이 PC 키", AutoSize = true, Anchor = AnchorStyles.Left, Margin = P(0, 4, 12, 4) });
            box.Width = S(Wide - 150);
            grid.Controls.Add(box);
        }
        autoStart.Text = "Windows에 로그인하면 릴레이 자동으로 시작";
        autoStart.AutoSize = true;
        autoStart.Margin = P(0, 6, 0, 0);
        FlowLayoutPanel r2 = Column();
        r2.Controls.Add(grid);
        r2.Controls.Add(Note("둘 다 강사 화면의 [화면 공유] → [릴레이 PC 연결 방법]에 나와요.", true));
        r2.Controls.Add(autoStart);
        relayBox.Controls.Add(r2);

        col.Controls.Add(teacherBox);
        col.Controls.Add(relayBox);
        desktop.Text = "바탕 화면에 바로 가기 만들기";
        desktop.Checked = true;
        desktop.AutoSize = true;
        desktop.Margin = P(0, 10, 0, 0);
        col.Controls.Add(desktop);
        col.Controls.Add(Note("방화벽은 StudyShare 프로그램만 도메인·개인 네트워크에서 허용해요. 설정과 수업 자료는 " + Setup.HomeDir + "에 둬요.", true));
        options.Controls.Add(col);

        bool wasRelay = Setup.InstalledRole() == "relay";
        relay.Checked = wasRelay;
        teacher.Checked = !wasRelay;
    }

    void BuildProgress()
    {
        FlowLayoutPanel col = Column();
        status.Text = "준비하는 중…";
        status.AutoSize = true;
        bar.Size = new Size(S(Wide), S(22));
        bar.Margin = P(0, 10, 0, 0);
        col.Controls.Add(status);
        col.Controls.Add(bar);
        progress.Controls.Add(col);
    }

    void BuildDone()
    {
        FlowLayoutPanel col = Column();
        col.Controls.Add(new Label { Text = "설치했어요.", AutoSize = true, Font = new Font(Font.FontFamily, 11F, FontStyle.Bold), Margin = P(0, 0, 0, 0) });
        summary.AutoSize = true;
        summary.MaximumSize = new Size(S(Wide), 0);
        summary.Margin = P(0, 10, 0, 0);
        launch.AutoSize = true;
        launch.Checked = true;
        launch.Margin = P(0, 14, 0, 0);
        col.Controls.Add(summary);
        col.Controls.Add(launch);
        done.Controls.Add(col);
    }

    void OnBrowse(object sender, EventArgs e)
    {
        using (var dialog = new FolderBrowserDialog { Description = "run.bat이 있는 StudyShare 폴더를 고르세요.", ShowNewFolderButton = false })
            if (dialog.ShowDialog(this) == DialogResult.OK) importDir.Text = dialog.SelectedPath;
    }

    void OnNext(object sender, EventArgs e)
    {
        if (done.Visible)
        {
            // Through Explorer, so the program runs as the signed-in user rather than elevated like setup.
            if (launch.Checked) Process.Start(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows), "explorer.exe"),
                Setup.Quote(Setup.MainShortcut(installedRelay)));
            Close();
            return;
        }
        Options o = Collect();
        if (o == null || !Setup.StopRunning(Setup.InstallDir, this)) return;
        installing = true;
        next.Enabled = cancel.Enabled = false;
        ShowPage(progress);
        var worker = new Thread(delegate ()
        {
            try
            {
                string firewall = Setup.Install(o, payload, (text, pct) => BeginInvoke(new Action(delegate { status.Text = text; bar.Value = pct; })));
                BeginInvoke(new Action(delegate { Finish(o, firewall); }));
            }
            catch (Exception ex)
            {
                BeginInvoke(new Action(delegate { Failed(ex); }));
            }
        });
        worker.IsBackground = true;
        worker.Start();
    }

    /// <summary>The choices, or null after saying what to fix.</summary>
    Options Collect()
    {
        var o = new Options { Relay = relay.Checked, Desktop = desktop.Checked, AutoStart = relay.Checked && autoStart.Checked };
        if (o.Relay)
        {
            string address = origin.Text.Trim().TrimEnd('/');
            if (address != "" && !Regex.IsMatch(address, "^https?://", RegexOptions.IgnoreCase)) address = "http://" + address;
            if (!Uri.IsWellFormedUriString(address, UriKind.Absolute)) return Invalid(origin, "강사 PC 주소를 넣으세요. 예: http://10.0.0.5:3000");
            if (key.Text.Trim() == "") return Invalid(key, "릴레이 PC 키를 넣으세요.");
            o.Origin = address;
            o.Key = key.Text.Trim();
        }
        else if (import.Checked)
        {
            string problem = Setup.CheckImport(importDir.Text.Trim());
            if (problem != null) return Invalid(importDir, problem);
            o.ImportFrom = importDir.Text.Trim();
        }
        return o;
    }

    Options Invalid(Control field, string message)
    {
        MessageBox.Show(this, message, Text, MessageBoxButtons.OK, MessageBoxIcon.Warning);
        field.Focus();
        return null;
    }

    void Finish(Options o, string firewall)
    {
        installing = false;
        installedRelay = o.Relay;
        var lines = new List<string>();
        if (o.Relay)
        {
            lines.Add("시작 메뉴의 'StudyShare 릴레이'로 켜요. 창이 열려 있는 동안 강사 화면의 [화면 공유 중] 표에 이 PC가 보여요.");
            lines.Add("주소나 키를 바꾸려면: 시작 메뉴 → StudyShare 릴레이 설정");
        }
        else
        {
            lines.Add("시작 메뉴의 'StudyShare'로 켜요. 브라우저가 열리고, 창을 닫으면 서버가 멈춰요.");
            lines.Add("포트·AI 키·관리자 비밀번호: 시작 메뉴 → StudyShare 설정");
            lines.Add("수업 자료: " + Path.Combine(Setup.HomeDir, "data") + " (백업은 이 폴더를 복사하세요)");
        }
        lines.Add(firewall);
        summary.Text = string.Join("\n\n", lines);
        launch.Text = "지금 " + Setup.MainName(o.Relay) + " 켜기";
        next.Text = "마침";
        next.Enabled = true;
        cancel.Visible = false;
        ShowPage(done);
    }

    void Failed(Exception e)
    {
        installing = false;
        MessageBox.Show(this, "설치하지 못했어요.\n\n" + e.Message, Text, MessageBoxButtons.OK, MessageBoxIcon.Error);
        next.Enabled = cancel.Enabled = true;
        ShowPage(options);
    }

    protected override void OnFormClosing(FormClosingEventArgs e)
    {
        if (installing) e.Cancel = true;
        base.OnFormClosing(e);
    }

    void ShowPage(Panel page)
    {
        foreach (Panel p in new[] { options, progress, done }) p.Visible = p == page;
    }

    static float DpiScale()
    {
        using (Graphics g = Graphics.FromHwnd(IntPtr.Zero)) return g.DpiX / 96F;
    }

    static int S(int px) { return (int)Math.Round(px * Dpi); }

    static Padding P(int left, int top, int right, int bottom) { return new Padding(S(left), S(top), S(right), S(bottom)); }

    static Panel Page() { return new Panel { Dock = DockStyle.Fill }; }

    static GroupBox Box(string title)
    {
        return new GroupBox
        {
            Text = title,
            AutoSize = true,
            AutoSizeMode = AutoSizeMode.GrowAndShrink,
            MinimumSize = new Size(S(Wide), 0),
            MaximumSize = new Size(S(Wide), 0),
            Padding = P(10, 6, 10, 8),
            Margin = P(0, 12, 0, 0),
        };
    }

    static FlowLayoutPanel Column()
    {
        return new FlowLayoutPanel { FlowDirection = FlowDirection.TopDown, WrapContents = false, AutoSize = true, Dock = DockStyle.Top, Margin = P(0, 0, 0, 0) };
    }

    static Label Note(string text, bool muted, int indent = 0)
    {
        return new Label
        {
            Text = text,
            AutoSize = true,
            MaximumSize = new Size(S(Wide - indent - 24), 0),
            ForeColor = muted ? SystemColors.GrayText : SystemColors.ControlText,
            Margin = P(indent, 3, 0, 0),
        };
    }

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    static extern IntPtr SendMessage(IntPtr hwnd, int msg, IntPtr wParam, string lParam);

    /// <summary>Grey example text shown while the box is empty.</summary>
    static void Cue(TextBox box, string text)
    {
        const int EM_SETCUEBANNER = 0x1501;
        SendMessage(box.Handle, EM_SETCUEBANNER, IntPtr.Zero, text);
    }
}
