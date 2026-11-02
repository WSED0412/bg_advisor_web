// Opening the web page: in Windows' default browser, or, only if that fails, in the browser the
// page last ran in.
//
// The page tells the bridge which browser it runs in (a name from a fixed list). The executable
// is looked up in the Windows registry (StartMenuInternet, App Paths) - never taken from the
// page - so a web page cannot make the plugin start anything but a registered browser.

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using Microsoft.Win32;

namespace BgAdvisorBridge
{
    public static class Browsers
    {
        static readonly Dictionary<string, string> Exe = new Dictionary<string, string>
        {
            { "brave", "brave.exe" },
            { "firefox", "firefox.exe" },
            { "edge", "msedge.exe" },
            { "chrome", "chrome.exe" },
            { "vivaldi", "vivaldi.exe" },
        };

        public static bool IsKnown(string id)
        {
            return id != null && Exe.ContainsKey(id);
        }

        /// <summary>Full path of the browser's executable, or null.</summary>
        public static string Find(string id)
        {
            string exe;
            if (id == null || !Exe.TryGetValue(id, out exe)) return null;
            foreach (var hive in new[] { Registry.CurrentUser, Registry.LocalMachine })
            {
                foreach (var root in new[] { @"SOFTWARE\Clients\StartMenuInternet", @"SOFTWARE\WOW6432Node\Clients\StartMenuInternet" })
                {
                    using (var k = hive.OpenSubKey(root))
                    {
                        if (k == null) continue;
                        foreach (var name in k.GetSubKeyNames())
                        {
                            using (var c = k.OpenSubKey(name + @"\shell\open\command"))
                            {
                                var path = ExeOf(c == null ? null : c.GetValue("") as string);
                                if (Matches(path, exe)) return path;
                            }
                        }
                    }
                }
                using (var k = hive.OpenSubKey(@"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\" + exe))
                {
                    var path = ExeOf(k == null ? null : k.GetValue("") as string);
                    if (Matches(path, exe)) return path;
                }
            }
            return null;
        }

        /// <summary>Open url in Windows' default browser; in the given one only if that fails.</summary>
        public static string Open(string id, string url)
        {
            try
            {
                Process.Start(new ProcessStartInfo(url) { UseShellExecute = true });
                return "default";
            }
            catch (Exception)
            {
                var path = Find(id);
                if (path == null) throw;
                Process.Start(new ProcessStartInfo(path, "\"" + url + "\"") { UseShellExecute = false });
                return id;
            }
        }

        static bool Matches(string path, string exe)
        {
            return path != null && string.Equals(Path.GetFileName(path), exe, StringComparison.OrdinalIgnoreCase)
                   && File.Exists(path);
        }

        /// <summary>The program of a command line: "C:\x\y.exe" --args or C:\x\y.exe --args.</summary>
        static string ExeOf(string cmd)
        {
            if (string.IsNullOrWhiteSpace(cmd)) return null;
            cmd = cmd.Trim();
            if (cmd.StartsWith("\""))
            {
                int end = cmd.IndexOf('"', 1);
                return end > 1 ? cmd.Substring(1, end - 1) : null;
            }
            int i = cmd.IndexOf(".exe", StringComparison.OrdinalIgnoreCase);
            return i > 0 ? cmd.Substring(0, i + 4) : cmd;
        }
    }
}
