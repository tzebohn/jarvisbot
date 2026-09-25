const stats = [
  {
    label: "Servers",
    value: "128",
    change: "+12 this month",
    icon: "◈",
  },
  {
    label: "Songs Played",
    value: "24.8K",
    change: "+18.2%",
    icon: "♫",
  },
  {
    label: "Voice Commands",
    value: "8,492",
    change: "+9.4%",
    icon: "◉",
  },
  {
    label: "Active Sessions",
    value: "14",
    change: "Live now",
    icon: "●",
  },
];

const recentActivity = [
  {
    server: "Developer Lounge",
    action: "Played",
    detail: "The Weeknd — Blinding Lights",
    time: "2 min ago",
  },
  {
    server: "Late Night Coding",
    action: "Voice Command",
    detail: '"Jarvis, skip this song"',
    time: "8 min ago",
  },
  {
    server: "Gaming Room",
    action: "Played",
    detail: "Travis Scott — FE!N",
    time: "14 min ago",
  },
  {
    server: "Study Group",
    action: "Voice Command",
    detail: '"Jarvis, play lo-fi"',
    time: "21 min ago",
  },
  {
    server: "The Boys",
    action: "Queue Updated",
    detail: "3 tracks added to queue",
    time: "34 min ago",
  },
];

const commands = [
  { command: "play", uses: "3,842", percentage: 92 },
  { command: "skip", uses: "1,724", percentage: 65 },
  { command: "queue", uses: "1,286", percentage: 48 },
  { command: "pause", uses: "892", percentage: 34 },
  { command: "leave", uses: "748", percentage: 27 },
];

const providers = [
  { name: "YouTube", percentage: 68 },
  { name: "SoundCloud", percentage: 21 },
  { name: "Spotify", percentage: 11 },
];

export default function Home() {
  return (
    <main className="min-h-screen bg-[#07080c] text-white">
      <div className="mx-auto max-w-7xl px-6 py-10 lg:px-8">
        {/* Header */}
        <header className="mb-10 flex flex-col justify-between gap-6 sm:flex-row sm:items-center">
          <div>
            <div className="mb-2 flex items-center gap-2">
              <div className="h-2 w-2 rounded-full bg-emerald-400 shadow-[0_0_12px_rgba(52,211,153,0.8)]" />
              <span className="text-xs font-medium uppercase tracking-[0.2em] text-emerald-400">
                Jarvis Online
              </span>
            </div>

            <h1 className="text-3xl font-semibold tracking-tight">
              Dashboard
            </h1>

            <p className="mt-2 text-sm text-zinc-500">
              Monitor music, voice commands, and bot activity.
            </p>
          </div>

          <div className="flex items-center gap-3 rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-violet-500/10 text-sm text-violet-400">
              J
            </div>

            <div>
              <p className="text-sm font-medium">Jarvis</p>
              <p className="text-xs text-zinc-500">Music Assistant</p>
            </div>
          </div>
        </header>

        {/* Stats */}
        <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {stats.map((stat) => (
            <div
              key={stat.label}
              className="group rounded-2xl border border-white/[0.08] bg-white/[0.025] p-5 transition hover:border-violet-500/30 hover:bg-white/[0.04]"
            >
              <div className="mb-6 flex items-center justify-between">
                <span className="flex h-9 w-9 items-center justify-center rounded-lg border border-white/[0.08] bg-white/[0.04] text-sm text-zinc-400">
                  {stat.icon}
                </span>

                <span className="text-xs text-zinc-600">{stat.change}</span>
              </div>

              <p className="text-2xl font-semibold tracking-tight">
                {stat.value}
              </p>

              <p className="mt-1 text-sm text-zinc-500">{stat.label}</p>
            </div>
          ))}
        </section>

        {/* Main Content */}
        <section className="mt-6 grid gap-6 lg:grid-cols-[1.6fr_1fr]">
          {/* Activity */}
          <div className="rounded-2xl border border-white/[0.08] bg-white/[0.025]">
            <div className="flex items-center justify-between border-b border-white/[0.06] px-6 py-5">
              <div>
                <h2 className="font-medium">Recent Activity</h2>
                <p className="mt-1 text-xs text-zinc-500">
                  Latest activity across your servers
                </p>
              </div>

              <span className="rounded-full border border-white/10 px-3 py-1 text-xs text-zinc-500">
                Live
              </span>
            </div>

            <div>
              {recentActivity.map((activity, index) => (
                <div
                  key={`${activity.server}-${index}`}
                  className="flex items-center gap-4 border-b border-white/[0.05] px-6 py-4 last:border-0"
                >
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-violet-500/10 text-sm font-medium text-violet-400">
                    {activity.server.charAt(0)}
                  </div>

                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <p className="truncate text-sm font-medium">
                        {activity.server}
                      </p>

                      <span className="text-xs text-zinc-600">
                        {activity.action}
                      </span>
                    </div>

                    <p className="mt-1 truncate text-xs text-zinc-500">
                      {activity.detail}
                    </p>
                  </div>

                  <p className="shrink-0 text-xs text-zinc-600">
                    {activity.time}
                  </p>
                </div>
              ))}
            </div>
          </div>

          {/* Voice Assistant */}
          <div className="relative overflow-hidden rounded-2xl border border-violet-500/20 bg-gradient-to-br from-violet-500/[0.08] to-transparent p-6">
            <div className="absolute -right-16 -top-16 h-48 w-48 rounded-full bg-violet-500/10 blur-3xl" />

            <div className="relative">
              <div className="mb-8 flex items-center justify-between">
                <div>
                  <h2 className="font-medium">Voice Assistant</h2>
                  <p className="mt-1 text-xs text-zinc-500">
                    Wake word performance
                  </p>
                </div>

                <span className="rounded-full bg-emerald-400/10 px-3 py-1 text-xs text-emerald-400">
                  Active
                </span>
              </div>

              <div className="flex flex-col items-center py-5">
                <div className="relative flex h-32 w-32 items-center justify-center">
                  <div className="absolute h-full w-full rounded-full border border-violet-400/10" />
                  <div className="absolute h-24 w-24 rounded-full border border-violet-400/20" />
                  <div className="absolute h-16 w-16 rounded-full bg-violet-500/10 blur-xl" />

                  <div className="relative flex h-16 w-16 items-center justify-center rounded-full border border-violet-400/30 bg-violet-500/10 shadow-[0_0_40px_rgba(139,92,246,0.15)]">
                    <span className="text-xl text-violet-300">◉</span>
                  </div>
                </div>

                <p className="mt-4 text-lg font-medium">“Jarvis”</p>
                <p className="mt-1 text-xs text-zinc-500">
                  Wake phrase
                </p>
              </div>

              <div className="mt-6 grid grid-cols-2 gap-3">
                <div className="rounded-xl border border-white/[0.06] bg-black/20 p-4">
                  <p className="text-lg font-medium">96.4%</p>
                  <p className="mt-1 text-xs text-zinc-500">
                    Recognition
                  </p>
                </div>

                <div className="rounded-xl border border-white/[0.06] bg-black/20 p-4">
                  <p className="text-lg font-medium">342ms</p>
                  <p className="mt-1 text-xs text-zinc-500">
                    Avg. Response
                  </p>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Bottom */}
        <section className="mt-6 grid gap-6 lg:grid-cols-2">
          {/* Commands */}
          <div className="rounded-2xl border border-white/[0.08] bg-white/[0.025] p-6">
            <div className="mb-7">
              <h2 className="font-medium">Popular Commands</h2>
              <p className="mt-1 text-xs text-zinc-500">
                Most frequently used bot commands
              </p>
            </div>

            <div className="space-y-5">
              {commands.map((item) => (
                <div key={item.command}>
                  <div className="mb-2 flex items-center justify-between">
                    <span className="font-mono text-sm text-zinc-300">
                      !{item.command}
                    </span>

                    <span className="text-xs text-zinc-500">
                      {item.uses} uses
                    </span>
                  </div>

                  <div className="h-1.5 overflow-hidden rounded-full bg-white/[0.06]">
                    <div
                      className="h-full rounded-full bg-violet-500"
                      style={{ width: `${item.percentage}%` }}
                    />
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Providers */}
          <div className="rounded-2xl border border-white/[0.08] bg-white/[0.025] p-6">
            <div className="mb-7">
              <h2 className="font-medium">Music Sources</h2>
              <p className="mt-1 text-xs text-zinc-500">
                Playback requests by provider
              </p>
            </div>

            <div className="space-y-4">
              {providers.map((provider) => (
                <div
                  key={provider.name}
                  className="rounded-xl border border-white/[0.06] bg-black/10 p-4"
                >
                  <div className="mb-3 flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-white/[0.05] text-xs">
                        ♫
                      </div>

                      <span className="text-sm font-medium">
                        {provider.name}
                      </span>
                    </div>

                    <span className="text-sm text-zinc-400">
                      {provider.percentage}%
                    </span>
                  </div>

                  <div className="h-1.5 overflow-hidden rounded-full bg-white/[0.06]">
                    <div
                      className="h-full rounded-full bg-violet-500"
                      style={{ width: `${provider.percentage}%` }}
                    />
                  </div>
                </div>
              ))}
            </div>

            <div className="mt-5 rounded-xl border border-white/[0.06] bg-black/10 px-4 py-3">
              <div className="flex items-center justify-between">
                <span className="text-xs text-zinc-500">
                  Total requests
                </span>

                <span className="text-sm font-medium">24,821</span>
              </div>
            </div>
          </div>
        </section>

        {/* Footer */}
        <footer className="mt-10 flex flex-col gap-2 border-t border-white/[0.06] pt-6 text-xs text-zinc-600 sm:flex-row sm:items-center sm:justify-between">
          <p>Jarvis Music Assistant</p>

          <div className="flex items-center gap-2">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
            All systems operational
          </div>
        </footer>
      </div>
    </main>
  );
}