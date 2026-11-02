// A tiny HTTP server on 127.0.0.1 that hands the bg_advisor web page the recent Power.log
// files, so the page needs no folder permission and Logs can stay under Program Files.
//
//   GET /status?browser=b  {"name","version","port","gameEnds","logDir","logDirOk","browser",
//                           "backupDir","logBackups","reports"}
//                          (b: the browser the page runs in, remembered to open it later)
//                          Without the token: only {"name","version","port","auth":"required"}.
//   GET /logs[?all=1]      [{"source","size","modified"}]  Power.log of the recent sessions
//                          (all=1: every session, also those only left in the backup)
//   GET /log?source=...    the raw text of one of those files (from Logs, or else the backup)
//   GET /reports           ["key", ...]  reports kept in the backup
//   GET /report?key=...    one of them (JSON)
//   POST /report?key=...   keep a report (JSON body) in the backup
//   DELETE /report?key=... move a report to the backup's "deleted" folder
//
// Only the web app's origin (and local test pages) get CORS access, the Host header must be
// 127.0.0.1/localhost (no DNS rebinding), and only files from the current listing are served.
// Writes need an allowed Origin and only touch Documents\BG Advisor\reports (see Backup.cs).
// The server never listens on another interface.
//
// Since 0.4.0 every request but the short /status needs "Authorization: Bearer <token>" (401
// otherwise). The token is random, kept by the plugin (Plugin.cs) and handed to the page only in
// the address the plugin opens (#/bridge/<port>/<token>), so another page on this computer - a
// local web server on any port - cannot read the logs or change the backup.

using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Threading;

namespace BgAdvisorBridge
{
    public sealed class BridgeServer : IDisposable
    {
        public const string SiteOrigin = "https://wsed0412.github.io";
        public const string SiteUrl = "https://wsed0412.github.io/bg_advisor_web/";
        public const int FirstPort = 47613;
        public const int LastPort = 47617;
        public const string Version = "0.4.1";
        const int RecentSessions = 3;

        const int MaxReportBytes = 32 * 1024 * 1024;

        readonly Func<string> _logDir;
        readonly Action<string> _log;
        readonly Backup _backup;
        TcpListener _listener;
        Thread _thread;
        volatile bool _running;
        int _gameEnds;
        long _lastPollTicks;

        public int Port { get; private set; }

        volatile string _token;

        /// <summary>The secret a page must send (Authorization: Bearer ...); replaceable at any time.</summary>
        public string Token { get { return _token; } set { _token = value; } }

        /// <summary>The browser the last page runs in ("brave", "firefox", ...), or null.</summary>
        public string Browser { get; set; }

        /// <summary>Called with the new browser id when a page reports a different one.</summary>
        public Action<string> BrowserChanged;
        public int GameEnds { get { return _gameEnds; } }

        /// <summary>When a page last asked for /status (UTC), or DateTime.MinValue.</summary>
        public DateTime LastPoll
        {
            get { return new DateTime(Interlocked.Read(ref _lastPollTicks), DateTimeKind.Utc); }
        }

        public BridgeServer(Func<string> logDir, Backup backup, Action<string> log = null)
        {
            _logDir = logDir;
            _backup = backup;
            _log = log ?? (s => { });
        }

        public void Start()
        {
            for (int port = FirstPort; port <= LastPort; port++)
            {
                try
                {
                    var l = new TcpListener(IPAddress.Loopback, port);
                    l.Start();
                    _listener = l;
                    Port = port;
                    break;
                }
                catch (SocketException) { }
            }
            if (_listener == null) throw new InvalidOperationException("no free port in " + FirstPort + "-" + LastPort);
            _running = true;
            _thread = new Thread(AcceptLoop) { IsBackground = true, Name = "BgAdvisorBridge" };
            _thread.Start();
            _log("listening on 127.0.0.1:" + Port);
        }

        public void NotifyGameEnd()
        {
            Interlocked.Increment(ref _gameEnds);
        }

        public void Dispose()
        {
            _running = false;
            try { if (_listener != null) _listener.Stop(); } catch { }
        }

        void AcceptLoop()
        {
            while (_running)
            {
                TcpClient c;
                try { c = _listener.AcceptTcpClient(); }
                catch { if (!_running) return; continue; }
                ThreadPool.QueueUserWorkItem(_ => Handle(c));
            }
        }

        // ------------------------------------------------------------------ HTTP

        sealed class Request
        {
            public string Method, Path, Query;
            public Dictionary<string, string> Headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        }

        static Request ReadRequest(Stream s)
        {
            var buf = new List<byte>(1024);
            int b, matched = 0;
            byte[] end = { 13, 10, 13, 10 };
            while ((b = s.ReadByte()) >= 0)
            {
                buf.Add((byte)b);
                matched = b == end[matched] ? matched + 1 : (b == 13 ? 1 : 0);
                if (matched == 4) break;
                if (buf.Count > 16384) return null;
            }
            if (matched != 4) return null;
            var lines = Encoding.ASCII.GetString(buf.ToArray()).Split(new[] { "\r\n" }, StringSplitOptions.None);
            var first = lines[0].Split(' ');
            if (first.Length < 2) return null;
            var r = new Request { Method = first[0] };
            var target = first[1];
            int q = target.IndexOf('?');
            r.Path = q >= 0 ? target.Substring(0, q) : target;
            r.Query = q >= 0 ? target.Substring(q + 1) : "";
            for (int i = 1; i < lines.Length; i++)
            {
                int c = lines[i].IndexOf(':');
                if (c > 0) r.Headers[lines[i].Substring(0, c).Trim()] = lines[i].Substring(c + 1).Trim();
            }
            return r;
        }

        /// <summary>Whether the request carries the token (compared in constant time).</summary>
        bool Authorized(Request r)
        {
            string token = _token, auth;
            if (string.IsNullOrEmpty(token) || !r.Headers.TryGetValue("Authorization", out auth)) return false;
            const string Bearer = "Bearer ";
            if (!auth.StartsWith(Bearer, StringComparison.Ordinal)) return false;
            return SameSecret(auth.Substring(Bearer.Length).Trim(), token);
        }

        /// <summary>Equal strings, in a time that depends only on their lengths.</summary>
        public static bool SameSecret(string a, string b)
        {
            if (a == null || b == null) return false;
            int diff = a.Length ^ b.Length;
            for (int i = 0; i < a.Length && i < b.Length; i++) diff |= a[i] ^ b[i];
            return diff == 0;
        }

        static bool AllowedOrigin(string origin)
        {
            if (string.IsNullOrEmpty(origin)) return false;
            if (origin == SiteOrigin) return true;
            Uri u;
            // Local copies of the web app (development / tests).
            return Uri.TryCreate(origin, UriKind.Absolute, out u) && u.Scheme == "http"
                   && (u.Host == "127.0.0.1" || u.Host == "localhost");
        }

        bool AllowedHost(string host)
        {
            return host == "127.0.0.1:" + Port || host == "localhost:" + Port;
        }

        void Handle(TcpClient client)
        {
            // Keep-alive: the client closes the connection (or it idles out). Closing right
            // after a large response let connections be reset before the client read it all.
            using (client)
            {
                try
                {
                    client.ReceiveTimeout = 15000;
                    client.SendTimeout = 30000;
                    client.NoDelay = true;
                    var s = client.GetStream();
                    while (_running)
                    {
                        var r = ReadRequest(s);
                        if (r == null) return;  // closed by the client, or idle
                        if (!HandleOne(s, r)) return;
                    }
                }
                catch (IOException) { }  // idle timeout or the client went away
                catch (Exception e)
                {
                    _log("request failed: " + e.Message);
                }
            }
        }

        /// <summary>Answers one request; false when the connection should close.</summary>
        bool HandleOne(Stream s, Request r)
        {
            string host, origin, accept;
            r.Headers.TryGetValue("Host", out host);
            r.Headers.TryGetValue("Origin", out origin);
            r.Headers.TryGetValue("Accept-Encoding", out accept);
            bool gzip = accept != null && accept.IndexOf("gzip", StringComparison.OrdinalIgnoreCase) >= 0;
            if (!AllowedHost(host)) { Send(s, 403, "text/plain", Bytes("bad host"), null, false, false); return false; }
            // A request from another web site: refuse outright.
            if (!string.IsNullOrEmpty(origin) && !AllowedOrigin(origin))
            {
                Send(s, 403, "text/plain", Bytes("origin not allowed"), null, false, false);
                return false;
            }
            if (r.Method == "OPTIONS") { Send(s, 204, null, new byte[0], origin, true); return true; }
            if (r.Method == "POST" || r.Method == "DELETE")
            {
                byte[] body;
                if (!ReadBody(s, r, out body)) { Send(s, 413, "text/plain", Bytes("body too large"), origin, false, false); return false; }
                // Writes only from the web app itself, never from a request without an Origin.
                if (!AllowedOrigin(origin)) { Send(s, 403, "text/plain", Bytes("origin required"), null, false, false); return false; }
                if (!Authorized(r)) { Unauthorized(s, origin); return true; }
                return HandleWrite(s, r, origin, body);
            }
            if (r.Method != "GET") { Send(s, 405, "text/plain", Bytes("method not allowed"), origin, false, false); return false; }

            bool authorized = Authorized(r);
            if (r.Path == "/status" && !authorized)
            {
                // Enough to find the plugin and see its version (an older page or plugin can then
                // tell what to do), nothing about this computer.
                var hello = "{\"name\":\"bg_advisor_bridge\",\"version\":" + Json(Version) + ",\"port\":" + Port
                            + ",\"auth\":\"required\"}";
                Send(s, 200, "application/json", Bytes(hello), origin);
                return true;
            }
            if (!authorized) { Unauthorized(s, origin); return true; }

            if (r.Path == "/status")
            {
                Interlocked.Exchange(ref _lastPollTicks, DateTime.UtcNow.Ticks);
                string browser = QueryValue(r.Query, "browser");
                if (Browsers.IsKnown(browser) && browser != Browser)
                {
                    Browser = browser;
                    var cb = BrowserChanged;
                    if (cb != null) cb(browser);
                }
                string dir = SafeLogDir();
                var json = "{\"name\":\"bg_advisor_bridge\",\"version\":" + Json(Version) + ",\"port\":" + Port
                           + ",\"gameEnds\":" + GameEnds + ",\"logDir\":" + Json(dir)
                           + ",\"logDirOk\":" + (dir != null && Directory.Exists(dir) ? "true" : "false")
                           + ",\"browser\":" + Json(Browser) + ",\"backupDir\":" + Json(_backup.Root)
                           + ",\"logBackups\":" + SafeCount(() => _backup.LogSessions().Count)
                           + ",\"reports\":" + SafeCount(() => _backup.ReportKeys().Count) + "}";
                Send(s, 200, "application/json", Bytes(json), origin);
            }
            else if (r.Path == "/logs")
            {
                var items = Listing(QueryValue(r.Query, "all") == "1").Select(f => "{\"source\":" + Json(f.Item1) + ",\"size\":" + SizeOf(f.Item2)
                    + ",\"modified\":" + Json(f.Item2.LastWriteTimeUtc.ToString("o", CultureInfo.InvariantCulture)) + "}");
                Send(s, 200, "application/json", Bytes("[" + string.Join(",", items) + "]"), origin);
            }
            else if (r.Path == "/log")
            {
                string source = QueryValue(r.Query, "source");
                var hit = Listing(true).FirstOrDefault(f => f.Item1 == source);
                if (hit == null) { Send(s, 404, "text/plain", Bytes("not a recent Power.log"), origin); return true; }
                byte[] data;
                if (hit.Item2.Name.EndsWith(".gz", StringComparison.Ordinal))
                {
                    // Only in the backup: already gzip, so send it as is (or unpacked).
                    data = ReadBackup(hit.Item2, gzip);
                    Send(s, 200, "text/plain; charset=utf-8", data, origin, false, true, gzip);
                    _log("sent " + source + " from the backup (" + data.Length + " bytes)");
                    return true;
                }
                // Hearthstone may be writing the file: share everything.
                using (var fs = new FileStream(hit.Item2.FullName, FileMode.Open, FileAccess.Read,
                                               FileShare.ReadWrite | FileShare.Delete))
                using (var ms = new MemoryStream())
                {
                    if (gzip)
                    {
                        // Logs are plain text: gzip makes them about ten times smaller.
                        using (var gz = new GZipStream(ms, CompressionLevel.Fastest, true)) fs.CopyTo(gz);
                    }
                    else
                    {
                        fs.CopyTo(ms);
                    }
                    data = ms.ToArray();
                }
                Send(s, 200, "text/plain; charset=utf-8", data, origin, false, true, gzip);
                _log("sent " + source + " (" + data.Length + " bytes" + (gzip ? ", gzip" : "") + ")");
            }
            else if (r.Path == "/reports")
            {
                var keys = _backup.ReportKeys().Select(Json);
                Send(s, 200, "application/json", Bytes("[" + string.Join(",", keys) + "]"), origin);
            }
            else if (r.Path == "/report")
            {
                var data = _backup.ReadReport(QueryValue(r.Query, "key"));
                if (data == null) Send(s, 404, "text/plain", Bytes("no such report"), origin);
                else Send(s, 200, "application/json; charset=utf-8", data, origin);
            }
            else
            {
                Send(s, 404, "text/plain", Bytes("not found"), origin);
            }
            return true;
        }

        static void Unauthorized(Stream s, string origin)
        {
            Send(s, 401, "application/json", Bytes("{\"error\":\"token\"}"), origin);
        }

        bool HandleWrite(Stream s, Request r, string origin, byte[] body)
        {
            string key = QueryValue(r.Query, "key");
            if (r.Path != "/report" || !Backup.ValidKey(key))
            {
                Send(s, 404, "text/plain", Bytes("not found"), origin);
                return true;
            }
            if (r.Method == "DELETE")
            {
                bool gone = _backup.DeleteReport(key);
                Send(s, 200, "application/json", Bytes(gone ? "{\"deleted\":true}" : "{\"deleted\":false}"), origin);
                return true;
            }
            if (body.Length == 0 || body[0] != (byte)'{')
            {
                Send(s, 400, "text/plain", Bytes("JSON object expected"), origin);
                return true;
            }
            _backup.SaveReport(key, body);
            Send(s, 200, "application/json", Bytes("{\"saved\":true}"), origin);
            return true;
        }

        static bool ReadBody(Stream s, Request r, out byte[] body)
        {
            body = new byte[0];
            string len;
            long n = 0;
            if (r.Headers.TryGetValue("Content-Length", out len) && !long.TryParse(len, out n)) return false;
            if (n < 0 || n > MaxReportBytes) return false;
            body = new byte[n];
            int off = 0;
            while (off < n)
            {
                int got = s.Read(body, off, (int)n - off);
                if (got <= 0) throw new IOException("body cut off");
                off += got;
            }
            return true;
        }

        static long SizeOf(FileInfo f)
        {
            return f.Name.EndsWith(".gz", StringComparison.Ordinal) ? Backup.OriginalSize(f) : f.Length;
        }

        static int SafeCount(Func<int> f)
        {
            try { return f(); } catch { return 0; }
        }

        static byte[] ReadBackup(FileInfo gz, bool keepGzip)
        {
            if (keepGzip) return File.ReadAllBytes(gz.FullName);
            using (var fs = new FileStream(gz.FullName, FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
            using (var z = new GZipStream(fs, CompressionMode.Decompress))
            using (var ms = new MemoryStream())
            {
                z.CopyTo(ms);
                return ms.ToArray();
            }
        }

        string SafeLogDir()
        {
            try { return _logDir(); } catch { return null; }
        }

        /// <summary>(source, file) of Power.log in the most recent session folders (all: every
        /// session, also those only left in the backup), oldest first. A session still in Logs is
        /// served from there; its source is the same either way.</summary>
        List<Tuple<string, FileInfo>> Listing(bool all = false)
        {
            var outList = new List<Tuple<string, FileInfo>>();
            string dir = SafeLogDir();
            bool live = dir != null && Directory.Exists(dir);
            string rootName = live ? new DirectoryInfo(dir).Name : "Logs";
            var sessions = new SortedDictionary<string, FileInfo>(StringComparer.Ordinal);
            try
            {
                foreach (var name in _backup.LogSessions()) sessions[name] = _backup.LogBackup(name);
            }
            catch { }
            if (live)
            {
                foreach (var d in new DirectoryInfo(dir).GetDirectories("Hearthstone_*"))
                {
                    var f = new FileInfo(Path.Combine(d.FullName, "Power.log"));
                    if (f.Exists) sessions[d.Name] = f;
                }
            }
            var list = sessions.Where(kv => kv.Value != null).ToList();
            foreach (var kv in all ? list : list.Skip(Math.Max(0, list.Count - RecentSessions)))
                outList.Add(Tuple.Create(rootName + "/" + kv.Key + "/Power.log", kv.Value));
            if (live)
            {
                var flat = new FileInfo(Path.Combine(dir, "Power.log"));  // older clients write Logs/Power.log
                if (flat.Exists) outList.Add(Tuple.Create(rootName + "/Power.log", flat));
            }
            return outList;
        }

        static string QueryValue(string query, string key)
        {
            foreach (var part in query.Split('&'))
            {
                int e = part.IndexOf('=');
                if (e > 0 && Uri.UnescapeDataString(part.Substring(0, e)) == key)
                    return Uri.UnescapeDataString(part.Substring(e + 1).Replace('+', ' '));
            }
            return null;
        }

        static byte[] Bytes(string s) { return Encoding.UTF8.GetBytes(s); }

        static string Json(string s)
        {
            if (s == null) return "null";
            var sb = new StringBuilder("\"");
            foreach (char c in s)
            {
                if (c == '"' || c == '\\') sb.Append('\\').Append(c);
                else if (c < 0x20) sb.AppendFormat("\\u{0:x4}", (int)c);
                else sb.Append(c);
            }
            return sb.Append('"').ToString();
        }

        static void Send(Stream s, int status, string type, byte[] body, string origin, bool preflight = false,
                         bool keepAlive = true, bool gzip = false)
        {
            var reason = status == 200 ? "OK" : status == 204 ? "No Content" : status == 400 ? "Bad Request"
                       : status == 401 ? "Unauthorized" : status == 403 ? "Forbidden" : status == 404 ? "Not Found"
                       : status == 405 ? "Method Not Allowed" : status == 413 ? "Payload Too Large" : "Error";
            var h = new StringBuilder();
            h.Append("HTTP/1.1 ").Append(status).Append(' ').Append(reason).Append("\r\n");
            if (type != null) h.Append("Content-Type: ").Append(type).Append("\r\n");
            h.Append("Content-Length: ").Append(body.Length).Append("\r\n");
            h.Append("Cache-Control: no-store\r\n");
            h.Append(keepAlive ? "Connection: keep-alive\r\nKeep-Alive: timeout=15\r\n" : "Connection: close\r\n");
            if (gzip) h.Append("Content-Encoding: gzip\r\n");
            if (AllowedOrigin(origin))
            {
                h.Append("Access-Control-Allow-Origin: ").Append(origin).Append("\r\nVary: Origin\r\n");
                if (preflight)
                {
                    h.Append("Access-Control-Allow-Methods: GET, POST, DELETE\r\n");
                    h.Append("Access-Control-Allow-Headers: Content-Type, Authorization\r\n");
                    h.Append("Access-Control-Allow-Private-Network: true\r\n");
                    h.Append("Access-Control-Max-Age: 600\r\n");
                }
            }
            h.Append("\r\n");
            var head = Encoding.ASCII.GetBytes(h.ToString());
            s.Write(head, 0, head.Length);
            const int Chunk = 64 * 1024;
            for (int off = 0; off < body.Length; off += Chunk)
                s.Write(body, off, Math.Min(Chunk, body.Length - off));
            s.Flush();
        }
    }
}
