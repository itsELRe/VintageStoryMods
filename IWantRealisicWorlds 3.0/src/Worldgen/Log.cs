using System;

namespace IWantRealisticWorlds.Worldgen
{
    // Log sink for the worldgen systems. Mirrors the visualiser's global
    // console.log / console.warn so the same debug lines exist in-game (the user
    // wants the debug messages preserved in the C# port). The mod points Info/Warn
    // at api.Logger; the parity harness points them at Console.WriteLine. Verbose
    // per-subsystem diagnostics call Dbg, gated behind Debug (the DebugLogging
    // config flag) — the same "gate the health-check spam behind show_debug"
    // decision the JS todo flagged for the port.
    public static class Log
    {
        public static Action<string> Info = _ => { };
        public static Action<string> Warn = _ => { };
        public static bool Debug = false;

        public static void Dbg(string msg) { if (Debug) Info(msg); }
    }
}
