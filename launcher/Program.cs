using System;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Reflection;
using System.Text;
using System.Threading;
using System.Windows.Forms;

[assembly: AssemblyTitle("ZIENTSOV LATYNKA")]
[assembly: AssemblyDescription("Ukrainian spelling dictionary and transliterator")]
[assembly: AssemblyCompany("\u0417\u0454\u043d\u0446\u043e\u0432 \u0414\u043c\u0438\u0442\u0440\u043e \u0412\u043e\u043b\u043e\u0434\u0438\u043c\u0438\u0440\u043e\u0432\u0438\u0447")]
[assembly: AssemblyProduct("ZIENTSOV LATYNKA")]
[assembly: AssemblyCopyright("Copyright \u00a9 2026 \u0417\u0454\u043d\u0446\u043e\u0432 \u0414\u043c\u0438\u0442\u0440\u043e \u0412\u043e\u043b\u043e\u0434\u0438\u043c\u0438\u0440\u043e\u0432\u0438\u0447")]
[assembly: AssemblyVersion("0.4.11.0")]
[assembly: AssemblyFileVersion("0.4.11.0")]

internal static class Program
{
    private const string Url = "http://127.0.0.1:8765/";
    private const string HealthUrl = "http://127.0.0.1:8765/api/stats";
    private const int StartupTimeoutMilliseconds = 15000;

    [STAThread]
    private static int Main(string[] args)
    {
        bool noWindow = Array.Exists(args, value => string.Equals(value, "--no-window", StringComparison.OrdinalIgnoreCase));
        using (var mutex = new Mutex(false, "Local\\ZIENTSOV_LATYNKA_LAUNCHER"))
        {
            bool ownsMutex = false;
            try
            {
                try { ownsMutex = mutex.WaitOne(StartupTimeoutMilliseconds); }
                catch (AbandonedMutexException) { ownsMutex = true; }

                if (!EnsureServerReady())
                {
                    ShowError("\u041d\u0435 \u0432\u0434\u0430\u043b\u043e\u0441\u044f \u0437\u0430\u043f\u0443\u0441\u0442\u0438\u0442\u0438 ZIENTSOV LATYNKA. \u041f\u0435\u0440\u0435\u0432\u0441\u0442\u0430\u043d\u043e\u0432\u0456\u0442\u044c \u0437\u0430\u0441\u0442\u043e\u0441\u0443\u043d\u043e\u043a \u0430\u0431\u043e \u0437\u0432\u0435\u0440\u043d\u0456\u0442\u044c\u0441\u044f \u0434\u043e \u0440\u043e\u0437\u0440\u043e\u0431\u043d\u0438\u043a\u0430.");
                    return 1;
                }

                if (!noWindow) OpenApplicationWindow();
                return 0;
            }
            catch (Exception error)
            {
                ShowError("\u041f\u043e\u043c\u0438\u043b\u043a\u0430 \u0437\u0430\u043f\u0443\u0441\u043a\u0443 ZIENTSOV LATYNKA.\n\n" + error.Message);
                return 1;
            }
            finally
            {
                if (ownsMutex) mutex.ReleaseMutex();
            }
        }
    }

    private static bool EnsureServerReady()
    {
        if (IsServerReady()) return true;

        string root = AppDomain.CurrentDomain.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar);
        string nodeExecutable = Path.Combine(root, "runtime", "node.exe");
        string applicationScript = Path.Combine(root, "app", "app.js");
        if (!File.Exists(nodeExecutable) || !File.Exists(applicationScript)) return false;

        var start = new ProcessStartInfo
        {
            FileName = nodeExecutable,
            Arguments = Quote(applicationScript),
            WorkingDirectory = root,
            UseShellExecute = false,
            CreateNoWindow = true,
            WindowStyle = ProcessWindowStyle.Hidden
        };
        start.EnvironmentVariables["ZIENTSOV_NO_WINDOW"] = "1";
        Process server = Process.Start(start);
        var stopwatch = Stopwatch.StartNew();
        while (stopwatch.ElapsedMilliseconds < StartupTimeoutMilliseconds)
        {
            if (IsServerReady()) return true;
            if (server != null && server.HasExited) return false;
            Thread.Sleep(50);
        }
        return false;
    }

    private static bool IsServerReady()
    {
        try
        {
            var request = (HttpWebRequest)WebRequest.Create(HealthUrl);
            request.Method = "GET";
            request.Timeout = 350;
            request.ReadWriteTimeout = 350;
            request.KeepAlive = false;
            using (var response = (HttpWebResponse)request.GetResponse())
            using (var stream = response.GetResponseStream())
            using (var reader = new StreamReader(stream, Encoding.UTF8))
            {
                string body = reader.ReadToEnd();
                return response.StatusCode == HttpStatusCode.OK && body.Contains("\"project\":\"ZIENTSOV LATYNKA\"");
            }
        }
        catch { return false; }
    }

    private static void OpenApplicationWindow()
    {
        string[] browsers =
        {
            CombineEnvironment("PROGRAMFILES(X86)", "Microsoft", "Edge", "Application", "msedge.exe"),
            CombineEnvironment("PROGRAMFILES", "Microsoft", "Edge", "Application", "msedge.exe"),
            CombineEnvironment("LOCALAPPDATA", "Microsoft", "Edge", "Application", "msedge.exe"),
            CombineEnvironment("PROGRAMFILES", "Google", "Chrome", "Application", "chrome.exe"),
            CombineEnvironment("PROGRAMFILES(X86)", "Google", "Chrome", "Application", "chrome.exe")
        };

        foreach (string browser in browsers)
        {
            if (string.IsNullOrEmpty(browser) || !File.Exists(browser)) continue;
            try
            {
                Process.Start(new ProcessStartInfo
                {
                    FileName = browser,
                    Arguments = "--app=" + Url + " --start-maximized",
                    UseShellExecute = false
                });
                return;
            }
            catch { }
        }

        Process.Start(new ProcessStartInfo { FileName = Url, UseShellExecute = true });
    }

    private static string CombineEnvironment(string variable, params string[] parts)
    {
        string root = Environment.GetEnvironmentVariable(variable);
        if (string.IsNullOrEmpty(root)) return null;
        string result = root;
        foreach (string part in parts) result = Path.Combine(result, part);
        return result;
    }

    private static string Quote(string value)
    {
        return "\"" + value.Replace("\"", "\\\"") + "\"";
    }

    private static void ShowError(string message)
    {
        MessageBox.Show(message, "ZIENTSOV LATYNKA", MessageBoxButtons.OK, MessageBoxIcon.Error);
    }
}
