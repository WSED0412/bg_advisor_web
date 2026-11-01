// A tiny HTTP server on 127.0.0.1 that hands the bg_advisor web page the recent Power.log
// files, so the page needs no folder permission and Logs can stay under Program Files.
//
//   GET /status            {"name","version","port","gameEnds","logDir","logDirOk"}
//   GET /logs              [{"source","size","modified"}]  Power.log of the recent sessions
//   GET /log?source=...    the raw text of one of those files
//
// Only the web app's origin (and local test pages) get CORS access, the Host header must be
// 127.0.0.1/localhost (no DNS rebinding), and only files from the current listing are served.
// The server never writes anything and never listens on another interface.

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
        public const string Version = "0.1.0";
        const int RecentSessions = 3;

        readonly Func<string> _logDir;
        readonly Action<string> _log;
        TcpListener _listener;
        Thread _thread;
        volatile bool _running;
        int _gameEnds;
        long _lastPollTicks;

        public int Port { get; private set; }
        public int GameEnds { get { return _gameEnds; } }

        /// <summary>When a page last asked for /status (UTC), or DateTime.MinValue.</summary>
        public DateTime LastPoll
        {
            get { return new DateTime(Interlocked.Read(ref _lastPollTicks), DateTimeKind.Utc); }
        }

        public BridgeServer(Func<string> logDir, Action<string> log = null)
        {
            _logDir = logDir;
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
            if (r.Method != "GET") { Send(s, 405, "text/plain", Bytes("GET only"), origin, false, false); return false; }

            if (r.Path == "/status")
            {
                Interlocked.Exchange(ref _lastPollTicks, DateTime.UtcNow.Ticks);
                string dir = SafeLogDir();
                var json = "{\"name\":\"bg_advisor_bridge\",\"version\":" + Json(Version) + ",\"port\":" + Port
                           + ",\"gameEnds\":" + GameEnds + ",\"logDir\":" + Json(dir)
                           + ",\"logDirOk\":" + (dir != null && Directory.Exists(dir) ? "true" : "false") + "}";
                Send(s, 200, "application/json", Bytes(json), origin);
            }
            else if (r.Path == "/logs")
            {
                var items = Listing().Select(f => "{\"source\":" + Json(f.Item1) + ",\"size\":" + f.Item2.Length
                    + ",\"modified\":" + Json(f.Item2.LastWriteTimeUtc.ToString("o", CultureInfo.InvariantCulture)) + "}");
                Send(s, 200, "application/json", Bytes("[" + string.Join(",", items) + "]"), origin);
            }
            else if (r.Path == "/log")
            {
                string source = QueryValue(r.Query, "source");
                var hit = Listing().FirstOrDefault(f => f.Item1 == source);
                if (hit == null) { Send(s, 404, "text/plain", Bytes("not a recent Power.log"), origin); return true; }
                byte[] data;
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
            else
            {
                Send(s, 404, "text/plain", Bytes("not found"), origin);
            }
            return true;
        }

        string SafeLogDir()
        {
            try { return _logDir(); } catch { return null; }
        }

        /// <summary>(source, file) of Power.log in the most recent session folders, oldest first.</summary>
        List<Tuple<string, FileInfo>> Listing()
        {
            var outList = new List<Tuple<string, FileInfo>>();
            string dir = SafeLogDir();
            if (dir == null || !Directory.Exists(dir)) return outList;
            var root = new DirectoryInfo(dir);
            var sessions = root.GetDirectories("Hearthstone_*").OrderBy(d => d.Name, StringComparer.Ordinal).ToList();
            foreach (var d in sessions.Skip(Math.Max(0, sessions.Count - RecentSessions)))
            {
                var f = new FileInfo(Path.Combine(d.FullName, "Power.log"));
                if (f.Exists) outList.Add(Tuple.Create(root.Name + "/" + d.Name + "/Power.log", f));
            }
            var flat = new FileInfo(Path.Combine(dir, "Power.log"));  // older clients write Logs/Power.log
            if (flat.Exists) outList.Add(Tuple.Create(root.Name + "/Power.log", flat));
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
            var reason = status == 200 ? "OK" : status == 204 ? "No Content" : status == 403 ? "Forbidden"
                       : status == 404 ? "Not Found" : status == 405 ? "Method Not Allowed" : "Error";
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
                    h.Append("Access-Control-Allow-Methods: GET\r\n");
                    h.Append("Access-Control-Allow-Headers: *\r\n");
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
