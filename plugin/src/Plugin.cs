// HDT plugin: when a Battlegrounds game ends, let the bg_advisor web page review it.
//
// The plugin runs BridgeServer (127.0.0.1 only). An open report page notices the finished game
// by itself; if no page has asked the bridge for a while, the plugin opens the site - in the
// browser the page last ran in (remembered in %AppData%\HearthstoneDeckTracker\BgAdvisor.txt).
// Every Power.log with a Battlegrounds game, and every report the page makes, is also kept in
// Documents\BG Advisor (Backup.cs).

using System;
using System.IO;
using System.Threading.Tasks;
using System.Windows.Controls;
using Hearthstone_Deck_Tracker;
using Hearthstone_Deck_Tracker.API;
using Hearthstone_Deck_Tracker.Plugins;

namespace BgAdvisorBridge
{
    public class BgAdvisorPlugin : IPlugin
    {
        BridgeServer _server;
        Backup _backup;
        bool _battlegrounds;

        public string Name { get { return "BG Advisor（英雄戰場復盤）"; } }
        public string Description
        {
            get
            {
                return "每局英雄戰場結束後，自動在瀏覽器打開這局的復盤報告。\n"
                       + "分析在瀏覽器裡進行；外掛只在本機 127.0.0.1 提供 Power.log 給 "
                       + BridgeServer.SiteUrl + " 讀取。\n"
                       + "紀錄檔和報告都會備份在「文件\\BG Advisor」。";
            }
        }
        public string ButtonText { get { return "開啟復盤網頁"; } }
        public string Author { get { return "WSED0412"; } }
        public Version Version { get { return new Version(BridgeServer.Version); } }
        public MenuItem MenuItem { get { return null; } }

        public void OnLoad()
        {
            _backup = new Backup(Backup.DefaultRoot(), msg => Log("backup: " + msg));
            _server = new BridgeServer(LogDir, _backup, msg => Log("bridge: " + msg));
            _server.Browser = LoadBrowser();
            _server.BrowserChanged = SaveBrowser;
            try
            {
                _server.Start();
            }
            catch (Exception e)
            {
                Log("could not start: " + e.Message);
                _server = null;
                return;
            }
            GameEvents.OnGameStart.Add(OnGameStart);
            GameEvents.OnGameEnd.Add(OnGameEnd);
            BackupLogsLater(0);
        }

        /// <summary>Back up the logs in the background (Hearthstone keeps only a few sessions).</summary>
        void BackupLogsLater(int delayMs)
        {
            var backup = _backup;
            if (backup == null) return;
            Task.Delay(delayMs).ContinueWith(_ =>
            {
                try { backup.BackupLogs(LogDir()); }
                catch (Exception e) { Log("backup failed: " + e.Message); }
            });
        }

        public void OnUnload()
        {
            if (_server != null) _server.Dispose();
            _server = null;
        }

        public void OnButtonPress() { OpenSite(); }

        public void OnUpdate() { }

        void OnGameStart()
        {
            _battlegrounds = SafeIsBattlegrounds();
        }

        void OnGameEnd()
        {
            var server = _server;
            if (server == null) return;
            bool bg = _battlegrounds || SafeIsBattlegrounds();
            _battlegrounds = false;
            if (!bg) return;
            server.NotifyGameEnd();
            BackupLogsLater(6000);
            // Give Hearthstone a moment to finish the log; an open page will see the counter.
            Task.Delay(4000).ContinueWith(_ =>
            {
                if ((DateTime.UtcNow - server.LastPoll).TotalSeconds > 12) OpenSite();
            });
        }

        static bool SafeIsBattlegrounds()
        {
            try { return Hearthstone_Deck_Tracker.Core.Game.IsBattlegroundsMatch; } catch { return false; }
        }

        void OpenSite()
        {
            var server = _server;
            if (server == null) return;
            try
            {
                var used = Browsers.Open(server.Browser, BridgeServer.SiteUrl + "#/bridge/" + server.Port);
                Log("opened the site in " + used);
            }
            catch (Exception e)
            {
                Log("could not open the browser: " + e.Message);
            }
        }

        static string SettingsFile()
        {
            return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
                                "HearthstoneDeckTracker", "BgAdvisor.txt");
        }

        static string LoadBrowser()
        {
            try
            {
                var id = File.Exists(SettingsFile()) ? File.ReadAllText(SettingsFile()).Trim() : null;
                return Browsers.IsKnown(id) ? id : null;
            }
            catch { return null; }
        }

        static void SaveBrowser(string id)
        {
            try
            {
                File.WriteAllText(SettingsFile(), id);
                Log("browser: " + id);
            }
            catch (Exception e) { Log("could not save the browser: " + e.Message); }
        }

        static string LogDir()
        {
            string hs = null;
            try { hs = Config.Instance.HearthstoneDirectory; } catch { }
            if (string.IsNullOrEmpty(hs)) hs = @"C:\Program Files (x86)\Hearthstone";
            return Path.Combine(hs, "Logs");
        }

        static void Log(string msg)
        {
            try { Hearthstone_Deck_Tracker.Utility.Logging.Log.Info("[BgAdvisor] " + msg); } catch { }
        }
    }
}
