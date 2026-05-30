import { useState } from "react";
import Game from "./Game";
import { AGENT, MAX_FLOOR } from "./gameData";

type Screen = "menu" | "select" | "howto" | "playing" | "credits";

const SAVE_KEY = "agent_byton_unlocked";

function loadUnlockedFloor(): number {
  try {
    const v = localStorage.getItem(SAVE_KEY);
    return v ? Math.min(MAX_FLOOR, Math.max(1, parseInt(v))) : 1;
  } catch {
    return 1;
  }
}

function saveUnlockedFloor(floor: number) {
  try {
    localStorage.setItem(SAVE_KEY, String(floor));
  } catch { /* ignore */ }
}

export default function App() {
  const [screen, setScreen] = useState<Screen>("menu");
  const [startFloor, setStartFloor] = useState(1);
  const [unlockedFloor, setUnlockedFloor] = useState(loadUnlockedFloor);

  // Auto-save unlocked floor on game exit (passed via callback)
  const handleExit = (floor: number) => {
    const newUnlock = Math.max(unlockedFloor, floor);
    setUnlockedFloor(newUnlock);
    saveUnlockedFloor(newUnlock);
    setScreen("menu");
  };

  if (screen === "playing") {
    return (
      <Game
        floor={startFloor}
        unlockedFloor={unlockedFloor}
        onExit={handleExit}
        onFloorUnlock={(fl) => {
          const newUnlock = Math.max(unlockedFloor, fl);
          setUnlockedFloor(newUnlock);
          saveUnlockedFloor(newUnlock);
        }}
      />
    );
  }

  return (
    <div className="min-h-screen w-full bg-gradient-to-b from-zinc-900 via-zinc-950 to-black text-white flex items-center justify-center p-4 font-mono">
      <div className="w-full max-w-5xl">
        {/* Header */}
        <div className="text-center mb-6">
          <div className="inline-block px-4 py-1 bg-yellow-500 text-black font-bold text-xs tracking-widest mb-3">
            WEBZIM STUDIOS • ZIMBABWE
          </div>
          <h1 className="text-5xl md:text-7xl font-black tracking-tight bg-gradient-to-r from-white via-zinc-300 to-white bg-clip-text text-transparent drop-shadow-[0_0_30px_rgba(200,200,200,0.4)]">
            AGENT BYTON
          </h1>
          <p className="text-zinc-400 mt-2 text-sm tracking-widest">
            🏗️ TOWER ASSAULT • 30 FLOORS • HARARE SKYSCRAPER 🏗️
          </p>
        </div>

        {screen === "menu" && (
          <MainMenu
            onPlay={() => setScreen("select")}
            onHow={() => setScreen("howto")}
            onCredits={() => setScreen("credits")}
          />
        )}

        {screen === "select" && (
          <FloorSelect
            startFloor={startFloor}
            setStartFloor={setStartFloor}
            unlockedFloor={unlockedFloor}
            onStart={() => setScreen("playing")}
            onBack={() => setScreen("menu")}
          />
        )}

        {screen === "howto" && <HowTo onBack={() => setScreen("menu")} />}
        {screen === "credits" && <Credits onBack={() => setScreen("menu")} />}

        {/* Watermark */}
        <div className="mt-8 text-center text-[10px] text-zinc-600 tracking-wide">
          This game was created by <a href="https://webzim.shop" target="_blank" rel="noopener" className="text-zinc-500 hover:text-yellow-400 underline underline-offset-2 transition-colors">webzim.shop</a>
        </div>
      </div>
    </div>
  );
}

function MainMenu({
  onPlay,
  onHow,
  onCredits,
}: {
  onPlay: () => void;
  onHow: () => void;
  onCredits: () => void;
}) {
  return (
    <div className="max-w-md mx-auto bg-zinc-900/80 border-2 border-white/20 rounded-xl p-8 backdrop-blur-md shadow-2xl shadow-white/5">
      {/* Agent Byton avatar */}
      <div className="text-center mb-6">
        <div className="inline-flex items-center justify-center w-20 h-20 rounded-full bg-gradient-to-b from-zinc-700 to-black border-2 border-white/30 mb-3 text-5xl">
          🕵️
        </div>
        <div className="text-white font-black tracking-widest text-lg">AGENT BYTON</div>
        <div className="text-zinc-500 text-xs tracking-wider">The Black & White Agent</div>
      </div>
      <div className="space-y-3">
        <MenuButton onClick={onPlay} primary>
          ▶ BEGIN MISSION
        </MenuButton>
        <MenuButton onClick={onHow}>📖 HOW TO PLAY</MenuButton>
        <MenuButton onClick={onCredits}>ℹ CREDITS</MenuButton>
      </div>
      <div className="mt-6 pt-4 border-t border-zinc-700 text-center text-xs text-zinc-500">
        <div>📧 help@sirbyton.site</div>
        <div className="mt-1">🌐 zimdev.shop</div>
      </div>
    </div>
  );
}

function MenuButton({
  children,
  onClick,
  primary,
}: {
  children: React.ReactNode;
  onClick: () => void;
  primary?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={`w-full py-3 px-6 rounded-lg font-bold tracking-wider transition-all hover:scale-[1.02] active:scale-95 border-2 ${
        primary
          ? "bg-white text-black border-white hover:shadow-lg hover:shadow-white/20"
          : "bg-zinc-800 text-zinc-200 border-zinc-700 hover:border-white/40 hover:bg-zinc-700"
      }`}
    >
      {children}
    </button>
  );
}

function FloorSelect({
  startFloor,
  setStartFloor,
  unlockedFloor,
  onStart,
  onBack,
}: {
  startFloor: number;
  setStartFloor: (n: number) => void;
  unlockedFloor: number;
  onStart: () => void;
  onBack: () => void;
}) {
  return (
    <div className="bg-zinc-900/80 border-2 border-white/20 rounded-xl p-6 backdrop-blur-md shadow-2xl">
      <h2 className="text-2xl font-black text-white mb-4 text-center tracking-widest">
        🏗️ SELECT FLOOR
      </h2>

      <div className="bg-black/40 rounded-lg p-4 mb-4 border border-zinc-700">
        <div className="flex items-start gap-4">
          <div className="w-20 h-20 rounded flex items-center justify-center text-5xl shrink-0 bg-gradient-to-b from-zinc-700 to-black border border-white/20">
            {AGENT.emoji}
          </div>
          <div className="flex-1">
            <div className="text-white font-bold text-lg">{AGENT.name}</div>
            <div className="text-xs text-zinc-400 italic mb-2">{AGENT.title}</div>
            <div className="text-xs text-zinc-300">
              Armed with dual Desert Eagles. Agent Byton must clear every floor of the skyscraper to reach the top.
            </div>
            <div className="flex gap-3 mt-2 text-[11px]">
              <Stat2 label="HP" val={AGENT.hp} max={150} color="bg-red-500" />
              <Stat2 label="SPD" val={AGENT.speed * 30} max={150} color="bg-blue-500" />
              <Stat2 label="DMG" val={AGENT.damage * 5} max={150} color="bg-orange-500" />
            </div>
            <div className="text-[11px] text-zinc-400 mt-2">
              🔫 Starts with: <span className="text-yellow-300">{AGENT.weapon}</span>
            </div>
          </div>
        </div>
      </div>

      {/* Floor grid */}
      <div className="mb-4">
        <div className="text-xs text-zinc-400 tracking-widest mb-2">
          CURRENT FLOOR: <span className="text-white font-bold text-lg">{startFloor}</span>
          <span className="text-zinc-500 ml-2">/ {MAX_FLOOR}</span>
          <span className="text-zinc-500 ml-2">| Unlocked up to: <span className="text-green-400">Floor {unlockedFloor}</span></span>
        </div>
        <div className="grid grid-cols-6 sm:grid-cols-10 gap-1.5">
          {Array.from({ length: MAX_FLOOR }, (_, i) => i + 1).map((f) => {
            const locked = f > unlockedFloor;
            const isActive = f === startFloor;
            return (
              <button
                key={f}
                disabled={locked}
                onClick={() => setStartFloor(f)}
                className={`py-2 rounded text-xs font-bold border transition-all ${
                  locked
                    ? "bg-zinc-800/40 text-zinc-600 border-zinc-800 cursor-not-allowed"
                    : isActive
                    ? "bg-white text-black border-white scale-110 shadow-lg shadow-white/20"
                    : "bg-zinc-800 text-zinc-300 border-zinc-700 hover:border-white/40 hover:bg-zinc-700"
                }`}
              >
                {locked ? "🔒" : f}
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex gap-3">
        <button
          onClick={onBack}
          className="flex-1 py-3 rounded-lg bg-zinc-800 border-2 border-zinc-700 font-bold hover:bg-zinc-700 text-white"
        >
          ← BACK
        </button>
        <button
          onClick={onStart}
          className="flex-[2] py-3 rounded-lg bg-white text-black border-2 border-white font-black tracking-widest hover:shadow-lg hover:shadow-white/20"
        >
          🏗️ ENTER FLOOR {startFloor} →
        </button>
      </div>
    </div>
  );
}

function Stat2({ label, val, max, color }: { label: string; val: number; max: number; color: string }) {
  const pct = Math.min(100, (val / max) * 100);
  return (
    <div className="flex-1">
      <div className="text-zinc-500">{label}</div>
      <div className="h-1.5 bg-zinc-800 rounded overflow-hidden">
        <div className={`h-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function HowTo({ onBack }: { onBack: () => void }) {
  return (
    <div className="bg-zinc-900/80 border-2 border-white/20 rounded-xl p-6 max-w-2xl mx-auto">
      <h2 className="text-2xl font-black text-white mb-4 text-center">📖 HOW TO PLAY</h2>
      <div className="grid grid-cols-2 gap-3 text-sm">
        <Key2 k="A / D or ←/→" desc="Move Left / Right" />
        <Key2 k="W or SPACE" desc="Jump" />
        <Key2 k="Click / J" desc="Shoot" />
        <Key2 k="E" desc="Pick Up Weapon" />
        <Key2 k="R" desc="Reload" />
        <Key2 k="SHIFT" desc="Sprint" />
        <Key2 k="Q" desc="Switch Weapon" />
        <Key2 k="P / ESC" desc="Pause" />
      </div>
      <div className="mt-4 p-3 bg-black/40 rounded border border-zinc-700 text-xs text-zinc-300 space-y-1">
        <div>🔫 Eliminate all enemies on each floor to advance.</div>
        <div>💥 Shoot red fuel drums for massive explosions.</div>
        <div>📦 Break wooden crates for ammo and health drops.</div>
        <div>🔫 Pick up dropped weapons from defeated enemies.</div>
        <div>🛗 When the floor is cleared, enter the elevator to go up!</div>
        <div>🐕 Watch out for attack dogs from Floor 15 onward!</div>
        <div>🤖 Giant machine robots appear from Floor 21!</div>
      </div>
      <button
        onClick={onBack}
        className="mt-4 w-full py-3 rounded-lg bg-zinc-800 border-2 border-zinc-700 font-bold hover:bg-zinc-700 text-white"
      >
        ← BACK TO MENU
      </button>
    </div>
  );
}

function Key2({ k, desc }: { k: string; desc: string }) {
  return (
    <div className="flex items-center gap-2 p-2 bg-black/40 rounded border border-zinc-700">
      <kbd className="px-2 py-1 bg-white text-black text-xs font-bold rounded min-w-[80px] text-center">
        {k}
      </kbd>
      <span className="text-zinc-300 text-xs">{desc}</span>
    </div>
  );
}

function Credits({ onBack }: { onBack: () => void }) {
  return (
    <div className="bg-zinc-900/80 border-2 border-white/20 rounded-xl p-6 max-w-md mx-auto text-center">
      <h2 className="text-2xl font-black text-white mb-4">ℹ CREDITS</h2>
      <div className="space-y-3 text-sm text-zinc-300">
        <div className="text-6xl mb-4">🕵️</div>
        <div>
          <div className="text-white font-bold text-lg">AGENT BYTON</div>
          <div className="text-zinc-500">Tower Assault</div>
        </div>
        <div>
          <div className="text-zinc-400 font-bold">Developer</div>
          <div>WebZim Studios</div>
        </div>
        <div>
          <div className="text-zinc-400 font-bold">Setting</div>
          <div>🇿🇼 Harare Skyscraper • Zimbabwe</div>
        </div>
        <div>
          <div className="text-zinc-400 font-bold">Contact</div>
          <div>📧 help@sirbyton.site</div>
          <div>🌐 zimdev.shop</div>
        </div>
        <div className="pt-3 border-t border-zinc-700 text-xs text-zinc-500">
          Agent Byton v1.0 • Built with React + Canvas
        </div>
      </div>
      <button
        onClick={onBack}
        className="mt-6 w-full py-3 rounded-lg bg-zinc-800 border-2 border-zinc-700 font-bold hover:bg-zinc-700 text-white"
      >
        ← BACK
      </button>
    </div>
  );
}
