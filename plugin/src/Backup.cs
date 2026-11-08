// Backups in Documents\BG Advisor, so nothing is lost when Hearthstone deletes old logs or the
// browser's data is cleared:
//
//   logs\<session>.Power.log.gz   Power.log of every session with a Battlegrounds game (gzip)
//   reports\<key>.json            every report the web page made (sent by the page)
//   reports\deleted\<key>.json    reports deleted on the page (kept, not erased)
//   logs\<session>.nobg           a session already read that had no Battlegrounds game (its
//                                  time is the log's, so the log is read again once it changes)

using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Text;
using System.Text.RegularExpressions;

namespace BgAdvisorBridge
{
    public sealed class Backup
    {
        static readonly Regex KeyRe = new Regex("^[A-Za-z0-9_]{1,200}$");
        static readonly Regex SessionRe = new Regex("^Hearthstone_[0-9_]+$");
        static readonly byte[] BgMarker = Encoding.ASCII.GetBytes("GameType=GT_BATTLEGROUNDS");
        readonly object _lock = new object();
        readonly Action<string> _log;

        public string Root { get; private set; }
        string LogsDir { get { return Path.Combine(Root, "logs"); } }
        string ReportsDir { get { return Path.Combine(Root, "reports"); } }

        public Backup(string root, Action<string> log)
        {
            Root = root;
            _log = log ?? (s => { });
        }

        public static string DefaultRoot()
        {
            return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments), "BG Advisor");
        }

        // ------------------------------------------------------------------ logs

        /// <summary>The backup of a session folder's Power.log, or null.</summary>
        public FileInfo LogBackup(string session)
        {
            if (!SessionRe.IsMatch(session ?? "")) return null;
            var f = new FileInfo(Path.Combine(LogsDir, session + ".Power.log.gz"));
            return f.Exists ? f : null;
        }

        /// <summary>Session names that have a backup.</summary>
        public List<string> LogSessions()
        {
            if (!Directory.Exists(LogsDir)) return new List<string>();
            return new DirectoryInfo(LogsDir).GetFiles("Hearthstone_*.Power.log.gz")
                .Select(f => f.Name.Substring(0, f.Name.Length - ".Power.log.gz".Length))
                .Where(s => SessionRe.IsMatch(s)).ToList();
        }

        /// <summary>Size of the original file, from the gzip trailer.</summary>
        public static long OriginalSize(FileInfo gz)
        {
            using (var fs = new FileStream(gz.FullName, FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
            {
                if (fs.Length < 4) return 0;
                fs.Seek(-4, SeekOrigin.End);
                var b = new byte[4];
                fs.Read(b, 0, 4);
                return BitConverter.ToUInt32(b, 0);
            }
        }

        /// <summary>Copy every session's Power.log that changed since its backup and holds a
        /// Battlegrounds game. Safe to call often: unchanged logs are skipped.</summary>
        public void BackupLogs(string logDir)
        {
            if (logDir == null || !Directory.Exists(logDir)) return;
            lock (_lock)
            {
                Directory.CreateDirectory(LogsDir);
                foreach (var d in new DirectoryInfo(logDir).GetDirectories("Hearthstone_*"))
                {
                    if (!SessionRe.IsMatch(d.Name)) continue;
                    var src = new FileInfo(Path.Combine(d.FullName, "Power.log"));
                    if (!src.Exists) continue;
                    var dst = new FileInfo(Path.Combine(LogsDir, d.Name + ".Power.log.gz"));
                    if (dst.Exists && dst.LastWriteTimeUtc == src.LastWriteTimeUtc) continue;
                    var nobg = new FileInfo(Path.Combine(LogsDir, d.Name + ".nobg"));
                    if (nobg.Exists && nobg.LastWriteTimeUtc == src.LastWriteTimeUtc) continue;
                    try
                    {
                        CopyIfBattlegrounds(src, dst);
                    }
                    catch (Exception e)
                    {
                        _log("backup of " + d.Name + " failed: " + e.Message);
                    }
                }
            }
        }

        void CopyIfBattlegrounds(FileInfo src, FileInfo dst)
        {
            var tmp = dst.FullName + ".tmp";
            DateTime stamp = src.LastWriteTimeUtc;
            bool bg = false;
            int matched = 0;
            using (var fs = new FileStream(src.FullName, FileMode.Open, FileAccess.Read,
                                           FileShare.ReadWrite | FileShare.Delete))
            using (var outFs = new FileStream(tmp, FileMode.Create, FileAccess.Write))
            using (var gz = new GZipStream(outFs, CompressionLevel.Optimal))
            {
                var buf = new byte[1 << 16];
                int n;
                while ((n = fs.Read(buf, 0, buf.Length)) > 0)
                {
                    gz.Write(buf, 0, n);
                    for (int i = 0; i < n && !bg; i++)
                    {
                        matched = buf[i] == BgMarker[matched] ? matched + 1 : (buf[i] == BgMarker[0] ? 1 : 0);
                        if (matched == BgMarker.Length) bg = true;
                    }
                }
            }
            var nobg = Path.Combine(LogsDir, src.Directory.Name + ".nobg");
            if (!bg)
            {
                File.Delete(tmp);
                // Remember it, so this log is not read and compressed again until it changes.
                File.WriteAllBytes(nobg, new byte[0]);
                File.SetLastWriteTimeUtc(nobg, stamp);
                return;
            }
            MoveOver(tmp, dst.FullName);
            File.SetLastWriteTimeUtc(dst.FullName, stamp);
            if (File.Exists(nobg)) File.Delete(nobg);
            _log("backed up " + src.Directory.Name);
        }

        // ------------------------------------------------------------------ reports

        public static bool ValidKey(string key) { return key != null && KeyRe.IsMatch(key); }

        string DeletedDir { get { return Path.Combine(ReportsDir, "deleted"); } }

        public List<string> ReportKeys()
        {
            return KeysIn(ReportsDir);
        }

        /// <summary>Reports deleted on a page (in reports\deleted), so other browsers delete them too.</summary>
        public List<string> DeletedReportKeys()
        {
            return KeysIn(DeletedDir);
        }

        static List<string> KeysIn(string dir)
        {
            if (!Directory.Exists(dir)) return new List<string>();
            return new DirectoryInfo(dir).GetFiles("*.json")
                .Select(f => Path.GetFileNameWithoutExtension(f.Name)).Where(ValidKey).ToList();
        }

        /// <summary>Put tmp in place of path in one step when path exists (no moment without it).</summary>
        static void MoveOver(string tmp, string path)
        {
            if (File.Exists(path)) File.Replace(tmp, path, null);
            else File.Move(tmp, path);
        }

        public byte[] ReadReport(string key)
        {
            if (!ValidKey(key)) return null;
            var p = Path.Combine(ReportsDir, key + ".json");
            return File.Exists(p) ? File.ReadAllBytes(p) : null;
        }

        public void SaveReport(string key, byte[] json)
        {
            if (!ValidKey(key)) throw new ArgumentException("bad key");
            lock (_lock)
            {
                Directory.CreateDirectory(ReportsDir);
                var p = Path.Combine(ReportsDir, key + ".json");
                File.WriteAllBytes(p + ".tmp", json);
                MoveOver(p + ".tmp", p);
                // Made again (reviewed again, imported): no longer a deleted report.
                var del = Path.Combine(DeletedDir, key + ".json");
                if (File.Exists(del)) File.Delete(del);
            }
        }

        /// <summary>Move a report to reports\deleted (kept, so a mistake can be undone by hand).</summary>
        public bool DeleteReport(string key)
        {
            if (!ValidKey(key)) return false;
            lock (_lock)
            {
                var p = Path.Combine(ReportsDir, key + ".json");
                if (!File.Exists(p)) return false;
                Directory.CreateDirectory(DeletedDir);
                var to = Path.Combine(DeletedDir, key + ".json");
                if (File.Exists(to)) File.Delete(to);
                File.Move(p, to);
                return true;
            }
        }
    }
}
