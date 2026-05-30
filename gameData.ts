import { useEffect, useRef, useState } from "react";
import {
  AGENT,
  WEAPONS,
  getFloorTheme,
  getEnemyCount,
  getFloorEnemyPool,
  MAX_FLOOR,
  type WeaponId,
  type EnemyType,
} from "./gameData";

interface Props {
  floor: number;
  unlockedFloor: number;
  onExit: (f: number) => void;
  onFloorUnlock: (f: number) => void;
}

/* ────────── Game Types ────────── */
interface Player {
  x: number; y: number; vx: number; vy: number;
  w: number; h: number; onGround: boolean; facing: 1 | -1;
  hp: number; maxHp: number;
  weapon: WeaponId; ammo: number; reserveAmmo: number;
  reloading: boolean; reloadStart: number; lastShot: number;
  invuln: number; walkAnim: number; crouching: boolean;
  weaponInventory: WeaponId[]; inventoryAmmo: Record<WeaponId, number>; inventoryReserve: Record<WeaponId, number>;
  _lastTrigger?: boolean;
  jumpsLeft: number;
  lastJumpTime: number;
  _jumpWasDown?: boolean;
}

interface Enemy {
  x: number; y: number; vx: number; vy: number;
  w: number; h: number; hp: number; maxHp: number;
  weapon: WeaponId; ammo: number; lastShot: number;
  facing: 1 | -1; onGround: boolean;
  helmet: string; alertTimer: number; walkAnim: number;
  state: "patrol" | "engage"; patrolDir: 1 | -1; patrolTimer: number;
  type: EnemyType;
}

interface Bullet {
  x: number; y: number; vx: number; vy: number;
  damage: number; fromPlayer: boolean; color: string; life: number;
}

interface Platform {
  x: number; y: number; w: number; h: number;
  type: "ground" | "platform" | "wall";
}

interface Prop {
  x: number; y: number; w: number; h: number;
  type: "drum" | "crate" | "metal";
  hp: number; destroyed: boolean;
}

interface Particle {
  x: number; y: number; vx: number; vy: number;
  life: number; maxLife: number; color: string; size: number;
  gravity?: number; type: "spark" | "blood" | "smoke" | "fire" | "debris";
}

interface Pickup {
  x: number; y: number; w: number; h: number;
  type: "weapon" | "health" | "ammo"; weapon?: WeaponId; bob: number;
}

interface FloatingText {
  x: number; y: number; text: string; color: string; life: number; vy: number;
}

const GRAVITY = 0.7;
const JUMP_FORCE = -13;
const CANVAS_W = 960;
const CANVAS_H = 540;
const WORLD_H = 540;

/* ────────── Audio System (Web Audio API synthesis) ────────── */
let audioCtx: AudioContext | null = null;
function getAudioCtx(): AudioContext {
  if (!audioCtx) audioCtx = new AudioContext();
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}

function playTone(freq: number, dur: number, vol: number, type: OscillatorType = 'square', ramp: boolean = true) {
  try {
    const ctx = getAudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(vol * 0.15, ctx.currentTime);
    if (ramp) gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + dur);
    else gain.gain.linearRampToValueAtTime(0, ctx.currentTime + dur);
    osc.connect(gain); gain.connect(ctx.destination);
    osc.start(ctx.currentTime); osc.stop(ctx.currentTime + dur);
  } catch { /* audio not critical */ }
}

function playNoise(dur: number, vol: number) {
  try {
    const ctx = getAudioCtx();
    const buf = ctx.createBuffer(1, ctx.sampleRate * dur, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * vol * 0.15;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(vol * 0.12, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + dur);
    src.connect(gain); gain.connect(ctx.destination);
    src.start();
  } catch { /* */ }
}

let lastStepSound = 0;
function playSfx(sfx: 'shoot' | 'hit' | 'kill' | 'step' | 'jump' | 'reload' | 'explode' | 'pickup') {
  const now = performance.now();
  switch (sfx) {
    case 'shoot': playNoise(0.08, 0.5); playTone(200, 0.06, 0.3, 'square'); break;
    case 'hit': playTone(80, 0.12, 0.5, 'sawtooth'); playNoise(0.06, 0.25); break;
    case 'kill': playNoise(0.15, 0.6); playTone(50, 0.2, 0.4, 'sawtooth'); break;
    case 'step':
      if (now - lastStepSound < 180) return;
      lastStepSound = now;
      playTone(90, 0.05, 0.2, 'sine'); playNoise(0.03, 0.15);
      break;
    case 'jump': playTone(300, 0.1, 0.3, 'sine'); playTone(500, 0.08, 0.2, 'triangle'); break;
    case 'reload': playTone(600, 0.05, 0.25, 'square');
      setTimeout(() => playTone(700, 0.05, 0.2, 'square'), 100);
      break;
    case 'explode': playNoise(0.4, 0.8); playTone(30, 0.5, 0.6, 'sawtooth');
      setTimeout(() => playTone(20, 0.3, 0.4, 'sawtooth'), 150);
      break;
    case 'pickup': playTone(800, 0.06, 0.25, 'sine');
      setTimeout(() => playTone(1000, 0.06, 0.2, 'sine'), 60);
      break;
  }
}

/* ────────── Floor Layout Generator ────────── */
function generateFloor(fl: number) {
  const platforms: Platform[] = [];
  const props: Prop[] = [];
  const pickups: Pickup[] = [];
  const enemySpawns: { x: number; y: number; type: EnemyType; weapon: WeaponId }[] = [];

  // Building floor: single horizontal level with platforms and walls
  const groundY = WORLD_H - 60;
  const worldW = 1400 + fl * 40;

  // Full ground floor
  platforms.push({ x: 0, y: groundY, w: worldW, h: 60, type: "ground" });

  // Left boundary wall only — right side is the elevator (no wall blocking it)
  platforms.push({ x: 0, y: 0, w: 8, h: groundY, type: "wall" });

  // Scaffolding poles (short decorative, not full blocks — don't block path)
  const numPoles = 2 + Math.floor(fl / 8);
  for (let i = 0; i < numPoles; i++) {
    const cx = 200 + Math.random() * (worldW - 400);
    platforms.push({ x: cx, y: groundY - 30 - Math.random() * 20, w: 6, h: 30 + Math.random() * 20, type: "wall" });
  }

  // Floating platforms (scaffolding)
  const numPlat = 2 + Math.floor(fl / 8);
  for (let i = 0; i < numPlat; i++) {
    const px = 200 + Math.random() * (worldW - 400);
    const py = groundY - 80 - Math.random() * 160;
    platforms.push({ x: px, y: py, w: 80 + Math.random() * 100, h: 14, type: "platform" });
  }

  // Props
  const numProps = 5 + Math.floor(fl / 3);
  for (let i = 0; i < numProps; i++) {
    const px = 120 + Math.random() * (worldW - 240);
    const py = groundY - 30;
    const types: Prop["type"][] = Math.random() < 0.3 ? ["drum"] : Math.random() < 0.4 ? ["crate"] : ["metal"];
    const t = types[0];
    props.push({
      x: px, y: py, w: 28, h: 30, type: t,
      hp: t === "metal" ? 9999 : t === "drum" ? 20 : 15,
      destroyed: false,
    });
  }

  // Elevator (right side exit) — completely open, no blocking walls
  const elevX = worldW - 100;
  // Floor extends into elevator cabin for walking entry
  platforms.push({ x: elevX, y: groundY, w: 90, h: 8, type: "ground" });

  // Enemy spawns
  const pool = getFloorEnemyPool(fl);
  const enemyCount = getEnemyCount(fl);
  for (let i = 0; i < enemyCount; i++) {
    const ex = 120 + Math.random() * (worldW - 300);
    const type: EnemyType =
      pool.dogChance > 0 && Math.random() < pool.dogChance ? "dog" :
      pool.robotChance > 0 && Math.random() < pool.robotChance ? "robot" :
      "worker";
    const weapon = pool.weapons[Math.floor(Math.random() * pool.weapons.length)];
    enemySpawns.push({ x: ex, y: groundY - (type === "dog" ? 24 : 44), type, weapon });
  }

  // Health/ammo pickups
  const numPickups = 2 + Math.floor(fl / 10);
  for (let i = 0; i < numPickups; i++) {
    pickups.push({
      x: 200 + Math.random() * (worldW - 400),
      y: groundY - 25,
      w: 20, h: 20,
      type: Math.random() < 0.5 ? "health" : "ammo",
      bob: Math.random() * Math.PI * 2,
    });
  }

  return { platforms, props, pickups, enemySpawns, worldW, groundY, elevX };
}

/* ────────── Component ────────── */
export default function Game({ floor, onExit, onFloorUnlock }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [hudState, setHudState] = useState({
    hp: 100, maxHp: 100, ammo: 0, reserve: 0,
    weapon: "Desert Eagle", floor, score: 0, enemies: 0,
    paused: false,
    state: "intro" as "intro" | "playing" | "cleared" | "elevator" | "lost" | "complete",
    reloading: false, menuOpen: false,
  });

  const stateRef = useRef<{
    player: Player; enemies: Enemy[]; bullets: Bullet[]; particles: Particle[];
    pickups: Pickup[]; floatingTexts: FloatingText[];
    platforms: Platform[]; props: Prop[];
    worldW: number; groundY: number; elevX: number;
    cameraX: number;
    keys: Record<string, boolean>;
    mouse: { x: number; y: number; down: boolean };
    touchShoot: boolean;
    floor: number; score: number;
    state: "intro" | "playing" | "cleared" | "elevator" | "lost" | "complete";
    paused: boolean; introTime: number; elevatorTime: number;
    combo: number; comboTimer: number; screenShake: number;
    bulletHoles: { x: number; y: number; a: number }[];
    clearedTime: number;
  } | null>(null);

  function initFloor(fl: number, keepScore: number, keepWeapon?: WeaponId, keepHp?: number) {
    const { platforms, props, pickups, enemySpawns, worldW, groundY, elevX } = generateFloor(fl);
    const wid: WeaponId = keepWeapon ?? "pistol";
    const wd = WEAPONS[wid];

    const player: Player = {
      x: 60, y: groundY - 44,
      vx: 0, vy: 0, w: 24, h: 44, onGround: false, facing: 1,
      hp: keepHp ?? AGENT.hp, maxHp: AGENT.hp,
      weapon: wid, ammo: wd.magazine, reserveAmmo: wd.magazine * 4,
      reloading: false, reloadStart: 0, lastShot: 0,
      invuln: 0, walkAnim: 0, crouching: false,
      weaponInventory: keepWeapon ? [keepWeapon] : ["pistol"],
      inventoryAmmo: keepWeapon ? { [keepWeapon]: wd.magazine } as Record<WeaponId,number> : { pistol: wd.magazine } as Record<WeaponId,number>,
      inventoryReserve: keepWeapon ? { [keepWeapon]: wd.magazine * 3 } as Record<WeaponId,number> : { pistol: wd.magazine * 3 } as Record<WeaponId,number>,
      jumpsLeft: 2,
      lastJumpTime: 0,
      _jumpWasDown: false,
    };

    const helmets = ["#ffeb3b", "#ff5722", "#2196f3", "#4caf50", "#ffffff"];
    const enemies: Enemy[] = enemySpawns.map((s) => {
      const ew = WEAPONS[s.weapon];
      let hp: number;
      switch (s.type) {
        case "dog": hp = 20 + fl * 2; break;
        case "robot": hp = 200 + fl * 15; break;
        default: hp = 30 + fl * 3; break;
      }
      return {
        x: s.x, y: s.y,
        vx: 0, vy: 0,
        w: s.type === "dog" ? 20 : s.type === "robot" ? 36 : 24,
        h: s.type === "dog" ? 18 : s.type === "robot" ? 48 : 44,
        hp, maxHp: hp,
        weapon: s.weapon, ammo: ew.magazine,
        lastShot: 0, facing: -1, onGround: false,
        helmet: helmets[Math.floor(Math.random() * helmets.length)],
        alertTimer: 0, walkAnim: 0,
        state: "patrol", patrolDir: Math.random() < 0.5 ? -1 : 1, patrolTimer: 0,
        type: s.type,
      };
    });

    stateRef.current = {
      player, enemies, bullets: [], particles: [], pickups,
      floatingTexts: [], platforms, props, worldW, groundY, elevX,
      cameraX: 0,
      keys: stateRef.current?.keys ?? {},
      mouse: stateRef.current?.mouse ?? { x: 0, y: 0, down: false },
      touchShoot: false,
      floor: fl, score: keepScore,
      state: "intro", paused: false,
      introTime: 0, elevatorTime: 0, combo: 0, comboTimer: 0,
      screenShake: 0, bulletHoles: [], clearedTime: 0,
    };

    setHudState({
      hp: player.hp, maxHp: player.maxHp, ammo: player.ammo, reserve: player.reserveAmmo,
      weapon: wd.name, floor: fl, score: keepScore, enemies: enemies.length,
      paused: false, state: "intro", reloading: false, menuOpen: false,
    });
  }

  useEffect(() => { initFloor(floor, 0); }, []);

  /* ── Input ── */
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!stateRef.current) return;
      const k = e.key.toLowerCase();
      stateRef.current.keys[k] = true;
      if (k === "p" || k === "escape") {
        if (stateRef.current.state !== "cleared") {
          stateRef.current.paused = !stateRef.current.paused;
          setHudState(h => ({ ...h, paused: stateRef.current!.paused }));
        }
      }
      if (k === "r") tryReload();
      if (k === "e") tryPickup();
      if (k === "q") switchWeapon();
      if (k === " ") e.preventDefault();
      if (k === "enter") {
        if (stateRef.current.state === "intro") { stateRef.current.state = "playing"; setHudState(h => ({ ...h, state: "playing" })); }
        else if (stateRef.current.state === "cleared") nextFloor();
      }
    };
    const handleKeyUp = (e: KeyboardEvent) => { if (stateRef.current) stateRef.current.keys[e.key.toLowerCase()] = false; };
    const handleMouseMove = (e: MouseEvent) => {
      if (!canvasRef.current || !stateRef.current) return;
      const rect = canvasRef.current.getBoundingClientRect();
      const sx = (e.clientX - rect.left) * (CANVAS_W / rect.width);
      const sy = (e.clientY - rect.top) * (CANVAS_H / rect.height);
      stateRef.current.mouse.x = sx; stateRef.current.mouse.y = sy;
    };
    const handleMouseDown = (e: MouseEvent) => { if (e.button === 0 && stateRef.current) stateRef.current.mouse.down = true; };
    const handleMouseUp = (e: MouseEvent) => { if (e.button === 0 && stateRef.current) stateRef.current.mouse.down = false; };

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mousedown", handleMouseDown);
    window.addEventListener("mouseup", handleMouseUp);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mousedown", handleMouseDown);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, []);

  /* ── Actions ── */
  function tryReload() {
    const s = stateRef.current; if (!s) return;
    const p = s.player; const w = WEAPONS[p.weapon];
    if (p.reloading || p.ammo === w.magazine || p.reserveAmmo === 0) return;
    p.reloading = true; p.reloadStart = performance.now();
    playSfx('reload');
  }

  function tryPickup() {
    const s = stateRef.current; if (!s) return;
    const p = s.player;
    for (let i = s.pickups.length - 1; i >= 0; i--) {
      const pk = s.pickups[i];
      if (!aabb(p, pk)) continue;
      if (pk.type === "weapon" && pk.weapon) {
        const wid = pk.weapon;
        // Save ammo for current weapon before switching
        if (!p.inventoryAmmo[wid]) p.inventoryAmmo[wid] = 0;
        if (!p.inventoryReserve[wid]) p.inventoryReserve[wid] = 0;
        // Add to inventory if new
        if (!p.weaponInventory.includes(wid)) {
          p.weaponInventory.push(wid);
        }
        // Save current ammo state
        p.inventoryAmmo[p.weapon] = p.ammo;
        p.inventoryReserve[p.weapon] = p.reserveAmmo;
        // Switch to picked weapon, restoring saved ammo if we had it
        p.weapon = wid;
        const savedAmmo = p.inventoryAmmo[wid] || 0;
        const savedRes = p.inventoryReserve[wid] || 0;
        const w = WEAPONS[wid];
        p.ammo = savedAmmo > 0 ? savedAmmo : w.magazine;
        p.reserveAmmo = savedRes > 0 ? savedRes : w.magazine * 3;
        p.reloading = false;
        s.floatingTexts.push({ x: p.x, y: p.y - 10, text: `+${w.name} (${p.weaponInventory.length} guns)`, color: "#ffd54a", life: 60, vy: -1 });
        playSfx('pickup');
      } else if (pk.type === "health") {
        p.hp = Math.min(p.maxHp, p.hp + 50);
        playSfx('pickup');
        s.floatingTexts.push({ x: p.x, y: p.y - 10, text: "+40 HP", color: "#66ff66", life: 60, vy: -1 });
      } else if (pk.type === "ammo") {
        const w = WEAPONS[p.weapon]; p.reserveAmmo += w.magazine * 2;
        s.floatingTexts.push({ x: p.x, y: p.y - 10, text: "+AMMO", color: "#ffd54a", life: 60, vy: -1 });
        playSfx('pickup');
      }
      s.pickups.splice(i, 1); return;
    }
  }

  function switchWeapon() {
    const s = stateRef.current; if (!s) return;
    const p = s.player;
    if (p.weaponInventory.length <= 1) {
      s.floatingTexts.push({ x: p.x, y: p.y - 10, text: "Only 1 gun", color: "#ff6666", life: 40, vy: -1 });
      return;
    }
    // Save current ammo
    p.inventoryAmmo[p.weapon] = p.ammo;
    p.inventoryReserve[p.weapon] = p.reserveAmmo;
    // Find current index and cycle to next
    const curIdx = p.weaponInventory.indexOf(p.weapon);
    const nextIdx = (curIdx + 1) % p.weaponInventory.length;
    const nextWid = p.weaponInventory[nextIdx];
    // Restore saved ammo or default
    const w2 = WEAPONS[nextWid];
    p.weapon = nextWid;
    p.ammo = p.inventoryAmmo[nextWid] || w2.magazine;
    p.reserveAmmo = p.inventoryReserve[nextWid] || w2.magazine * 3;
    p.reloading = false;
    s.floatingTexts.push({ x: p.x, y: p.y - 10, text: `→ ${w2.name} [${nextIdx+1}/${p.weaponInventory.length}]`, color: "#66ccff", life: 50, vy: -1 });
  }

  function nextFloor() {
    const s = stateRef.current!;
    if (s.floor >= MAX_FLOOR) {
      s.state = "complete";
      setHudState(h => ({ ...h, state: "complete" }));
      onFloorUnlock(s.floor);
      return;
    }
    const nextFl = s.floor + 1;
    onFloorUnlock(nextFl);
    // Keep weapon & partial HP
    initFloor(nextFl, s.score, s.player.weapon, Math.min(s.player.maxHp, s.player.hp + 20));
  }

  /* ── Helpers ── */
  function aabb(a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) {
    return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  }

  function shootPlayer(now: number) {
    const s = stateRef.current!; const p = s.player; const w = WEAPONS[p.weapon];
    if (p.reloading || p.ammo <= 0) { if (p.ammo <= 0) tryReload(); return; }
    if (now - p.lastShot < w.fireRate) return;
    p.lastShot = now; p.ammo--;
    playSfx('shoot');

    const px = p.x + p.w / 2; const py = p.y + 14;
    let angle: number;

    // ── AUTO-AIM: find nearest visible enemy within range ──
    const autoRange = 350;
    let nearestEnemy: Enemy | null = null;
    let nearestDist = autoRange;
    for (const e of s.enemies) {
      const dx = (e.x + e.w/2) - px;
      const dy = (e.y + e.h/2) - py;
      const d = Math.sqrt(dx*dx + dy*dy);
      if (d < nearestDist) {
        const inFront = p.facing > 0 ? dx > -30 : dx < 30;
        if (inFront || d < 120) {
          nearestDist = d;
          nearestEnemy = e;
        }
      }
    }

    if (s.touchShoot) {
      if (nearestEnemy) {
        const tx2 = nearestEnemy.x + nearestEnemy.w/2;
        const ty2 = nearestEnemy.y + nearestEnemy.h/2;
        angle = Math.atan2(ty2 - py, tx2 - px);
        p.facing = tx2 > px ? 1 : -1;
      } else {
        angle = p.facing > 0 ? 0 : Math.PI;
      }
    } else {
      let tx = s.mouse.x + s.cameraX;
      let ty = s.mouse.y;
      if (nearestEnemy) {
        const ex = nearestEnemy.x + nearestEnemy.w/2;
        const ey = nearestEnemy.y + nearestEnemy.h/2;
        tx = tx * 0.6 + ex * 0.4;
        ty = ty * 0.6 + ey * 0.4;
      }
      angle = Math.atan2(ty - py, tx - px);
      p.facing = tx > px ? 1 : -1;
    }
    for (let i = 0; i < w.pellets; i++) {
      const a = angle + (Math.random() - 0.5) * 2 * w.spread;
      s.bullets.push({
        x: px + Math.cos(a) * 18, y: py + Math.sin(a) * 18,
        vx: Math.cos(a) * w.bulletSpeed, vy: Math.sin(a) * w.bulletSpeed,
        damage: w.damage, fromPlayer: true, color: w.color, life: 60,
      });
    }
    for (let i = 0; i < 5; i++) {
      const a = angle + (Math.random() - 0.5) * 0.6;
      s.particles.push({ x: px + Math.cos(angle) * 20, y: py + Math.sin(angle) * 20, vx: Math.cos(a) * (2 + Math.random() * 3), vy: Math.sin(a) * (2 + Math.random() * 3), life: 8, maxLife: 8, color: w.color, size: 3, type: "spark" });
    }
    s.screenShake = Math.min(s.screenShake + 2, 10);
    if (p.ammo === 0) tryReload();
  }

  function shootEnemy(e: Enemy, now: number) {
    const s = stateRef.current!; const w = WEAPONS[e.weapon];
    if (now - e.lastShot < w.fireRate) return;
    e.lastShot = now;
    if (e.ammo <= 0) { e.ammo = w.magazine; return; }
    e.ammo--;
    const p = s.player;
    const px = p.x + p.w / 2; const py = p.y + p.h / 2;
    const ex = e.x + e.w / 2; const ey = e.y + 14;
    const angle = Math.atan2(py - ey, px - ex);
    for (let i = 0; i < w.pellets; i++) {
      const a = angle + (Math.random() - 0.5) * 2 * (w.spread + 0.04);
      s.bullets.push({
        x: ex + Math.cos(a) * 16, y: ey + Math.sin(a) * 16,
        vx: Math.cos(a) * w.bulletSpeed * 0.8, vy: Math.sin(a) * w.bulletSpeed * 0.8,
        damage: Math.max(5, Math.floor(w.damage * 0.5)), fromPlayer: false, color: "#ff6666", life: 60,
      });
    }
    s.particles.push({ x: ex + Math.cos(angle) * 18, y: ey + Math.sin(angle) * 18, vx: 0, vy: 0, life: 5, maxLife: 5, color: "#ffaa00", size: 4, type: "spark" });
  }

  function damageEnemy(e: Enemy, dmg: number, headshot: boolean) {
    const s = stateRef.current!;
    e.hp -= dmg; e.alertTimer = 600; e.state = "engage";
    // 2x blood on hit (8 particles)
    for (let i = 0; i < 8; i++) s.particles.push({ x: e.x + e.w / 2, y: e.y + e.h / 2, vx: (Math.random() - 0.5) * 6, vy: (Math.random() - 0.5) * 6, life: 25, maxLife: 25, color: "#cc0000", size: 2 + Math.random() * 3, gravity: 0.2, type: "blood" });
    // Hit sound
    playSfx('hit');
    if (headshot) { s.score += 50; s.floatingTexts.push({ x: e.x, y: e.y - 20, text: "HEADSHOT!", color: "#ff3333", life: 50, vy: -1.2 }); }
    if (e.hp <= 0) {
      // 2x death blood (24 particles)
      for (let i = 0; i < 24; i++) s.particles.push({ x: e.x + e.w / 2, y: e.y + e.h / 2, vx: (Math.random() - 0.5) * 8, vy: -Math.random() * 7, life: 45, maxLife: 45, color: i % 3 === 0 ? "#ff0000" : "#aa0000", size: 2 + Math.random() * 4, gravity: 0.3, type: "blood" });
      playSfx('kill');
      // ── Guaranteed drop + variety ──
      const roll = Math.random();
      if (roll < 0.35) {
        // Weapon drop
        s.pickups.push({ x: e.x, y: e.y + 20, w: 24, h: 16, type: "weapon", weapon: e.weapon, bob: 0 });
      } else if (roll < 0.6) {
        // Heart kit (large health)
        s.pickups.push({ x: e.x, y: e.y + 20, w: 22, h: 22, type: "health", bob: 0 });
        s.floatingTexts.push({ x: e.x, y: e.y - 5, text: "❤️", color: "#ff4444", life: 40, vy: -1.5 });
      } else if (roll < 0.8) {
        // Ammo crate
        s.pickups.push({ x: e.x, y: e.y + 20, w: 20, h: 20, type: "ammo", bob: 0 });
        s.floatingTexts.push({ x: e.x, y: e.y - 5, text: "🔫 AMMO", color: "#ffd54a", life: 40, vy: -1.5 });
      } else {
        // Bonus: both small health + ammo
        s.pickups.push({ x: e.x - 8, y: e.y + 20, w: 16, h: 16, type: "health", bob: 0 });
        s.pickups.push({ x: e.x + 12, y: e.y + 20, w: 16, h: 16, type: "ammo", bob: 0 });
        s.floatingTexts.push({ x: e.x, y: e.y - 5, text: "BONUS!", color: "#ffaaff", life: 40, vy: -1.5 });
      }
      s.enemies.splice(s.enemies.indexOf(e), 1);
      s.combo++; s.comboTimer = 180;
      const bonus = 100 * Math.max(1, s.combo); s.score += bonus;
      if (s.combo > 1) s.floatingTexts.push({ x: e.x, y: e.y - 5, text: `x${s.combo} +${bonus}`, color: "#ffd54a", life: 50, vy: -1 });
    }
  }

  function damagePlayer(dmg: number) {
    const s = stateRef.current!; const p = s.player;
    if (p.invuln > 0) return;
    p.hp -= dmg; p.invuln = 30;
    s.screenShake = Math.min(s.screenShake + 6, 15);
    for (let i = 0; i < 6; i++) s.particles.push({ x: p.x + p.w / 2, y: p.y + p.h / 2, vx: (Math.random() - 0.5) * 4, vy: (Math.random() - 0.5) * 4, life: 20, maxLife: 20, color: "#ff3333", size: 2, gravity: 0.2, type: "blood" });
    if (p.hp <= 0) { p.hp = 0; s.state = "lost"; setHudState(h => ({ ...h, state: "lost" })); }
  }

  function explodeDrum(prop: Prop) {
    const s = stateRef.current!;
    playSfx('explode');
    const cx = prop.x + prop.w / 2, cy = prop.y + prop.h / 2, RAD = 90;
    s.enemies.forEach(e => { const dx = e.x + e.w / 2 - cx, dy = e.y + e.h / 2 - cy; if (Math.sqrt(dx * dx + dy * dy) < RAD) { damageEnemy(e, 80, false); e.vx += (dx / Math.max(1, Math.abs(dx))) * 6; e.vy -= 5; } });
    const dx = s.player.x + s.player.w / 2 - cx, dy = s.player.y + s.player.h / 2 - cy;
    if (Math.sqrt(dx * dx + dy * dy) < RAD) { damagePlayer(30); s.player.vx += (dx / Math.max(1, Math.abs(dx))) * 5; s.player.vy -= 4; }
    s.props.forEach(p2 => { if (p2 !== prop && !p2.destroyed && p2.type === "drum" && Math.sqrt((p2.x - cx) ** 2 + (p2.y - cy) ** 2) < RAD) { setTimeout(() => { if (!p2.destroyed && stateRef.current) { p2.destroyed = true; explodeDrum(p2); } }, 100); } });
    for (let i = 0; i < 40; i++) { const a = Math.random() * Math.PI * 2; s.particles.push({ x: cx, y: cy, vx: Math.cos(a) * (2 + Math.random() * 7), vy: Math.sin(a) * (2 + Math.random() * 7), life: 30 + Math.random() * 20, maxLife: 50, color: i % 2 ? "#ff8800" : "#ffdd00", size: 3 + Math.random() * 4, gravity: 0.1, type: "fire" }); }
    for (let i = 0; i < 20; i++) { const a = Math.random() * Math.PI * 2; s.particles.push({ x: cx, y: cy, vx: Math.cos(a) * 2, vy: Math.sin(a) * 2 - 2, life: 60, maxLife: 60, color: "#444", size: 6 + Math.random() * 6, type: "smoke" }); }
    s.screenShake = Math.min(s.screenShake + 12, 20);
  }

  function damageProp(prop: Prop, dmg: number) {
    if (prop.destroyed) return;
    prop.hp -= dmg;
    const s = stateRef.current!;
    if (prop.hp <= 0) {
      prop.destroyed = true;
      if (prop.type === "drum") explodeDrum(prop);
      else if (prop.type === "crate") {
        for (let i = 0; i < 12; i++) s.particles.push({ x: prop.x + prop.w / 2, y: prop.y + prop.h / 2, vx: (Math.random() - 0.5) * 6, vy: -Math.random() * 5, life: 40, maxLife: 40, color: "#8b5a2b", size: 3 + Math.random() * 3, gravity: 0.4, type: "debris" });
        if (Math.random() < 0.4) s.pickups.push({ x: prop.x, y: prop.y, w: 20, h: 20, type: Math.random() < 0.5 ? "health" : "ammo", bob: 0 });
      }
    }
  }

  /* ── Collision Helpers ── */
  function handleCollisionsX(e: { x: number; y: number; w: number; h: number; vx: number }) {
    const s = stateRef.current!;
    for (const pl of s.platforms) {
      if (pl.type === "platform") continue;
      if (aabb(e, pl)) { if (e.vx > 0) e.x = pl.x - e.w; else e.x = pl.x + pl.w; e.vx = 0; }
    }
    for (const pr of s.props) {
      if (pr.destroyed) continue;
      if (aabb(e, pr)) { if (e.vx > 0) e.x = pr.x - e.w; else e.x = pr.x + pr.w; e.vx = 0; }
    }
  }

  function handleCollisionsY(e: { x: number; y: number; w: number; h: number; vy: number; onGround: boolean }) {
    const s = stateRef.current!;
    e.onGround = false;
    for (const pl of s.platforms) {
      if (aabb(e, pl)) {
        if (pl.type === "platform") {
          if (e.vy > 0 && e.y + e.h - e.vy <= pl.y + 2) { e.y = pl.y - e.h; e.vy = 0; e.onGround = true; }
        } else {
          if (e.vy > 0) { e.y = pl.y - e.h; e.vy = 0; e.onGround = true; }
          else { e.y = pl.y + pl.h; e.vy = 0; }
        }
      }
    }
    for (const pr of s.props) {
      if (pr.destroyed) continue;
      if (aabb(e, pr)) { if (e.vy > 0) { e.y = pr.y - e.h; e.vy = 0; e.onGround = true; } else { e.y = pr.y + pr.h; e.vy = 0; } }
    }
  }

  /* ── Update Loop ── */
  function updateGame(now: number, dt: number) {
    const s = stateRef.current!; const p = s.player; const k = s.keys;
    const sprint = k["shift"] ? 1.5 : 1; const speed = AGENT.speed * sprint;
    p.crouching = !!(k["s"] || k["arrowdown"]);

    let moveX = 0;
    if (k["a"] || k["arrowleft"]) moveX = -1;
    if (k["d"] || k["arrowright"]) moveX = 1;
    if (moveX !== 0) { p.vx += moveX * 0.8 * sprint; p.facing = moveX > 0 ? 1 : -1; p.walkAnim += 0.25 * sprint; }
    else { p.walkAnim = 0; }
    p.vx = Math.max(-speed, Math.min(speed, p.vx));
    // Double jump: tap jump while on ground (first jump), tap again in air (second jump)
    const jumpKey = k["w"] || k[" "] || k["arrowup"];
    if (jumpKey && !p._jumpWasDown) {
      // Reset jumps when grounded
      if (p.onGround) p.jumpsLeft = 2;
      if (p.jumpsLeft > 0) {
        p.vy = p.jumpsLeft === 2 ? JUMP_FORCE : JUMP_FORCE * 0.6;
        p.onGround = false;
        p.jumpsLeft--;
        p.lastJumpTime = performance.now();
        // Small particle burst on double jump
        if (p.jumpsLeft === 0) {
          const s = stateRef.current!;
          for (let i = 0; i < 8; i++) {
            s.particles.push({ x: p.x + p.w/2, y: p.y + p.h, vx: (Math.random()-0.5)*3, vy: -Math.random()*3, life: 12, maxLife: 12, color: "#ffffff", size: 2, type: "spark" });
          }
          s.floatingTexts.push({ x: p.x, y: p.y - 20, text: "x2 JUMP", color: "#66ccff", life: 30, vy: -1 });
        }
        playSfx('jump');
      }
    }
    p._jumpWasDown = !!jumpKey;

    // Step sounds
    if (p.onGround && Math.abs(p.vx) > 1.5) playSfx('step');

    const shootPressed = s.mouse.down || k["j"] || k["control"] || s.touchShoot;
    if (shootPressed) { const w = WEAPONS[p.weapon]; if (w.auto || !p._lastTrigger) shootPlayer(now); p._lastTrigger = true; }
    else { p._lastTrigger = false; }

    if (p.reloading) { const w = WEAPONS[p.weapon]; if (now - p.reloadStart >= w.reloadTime) { const need = w.magazine - p.ammo; const take = Math.min(need, p.reserveAmmo); p.ammo += take; p.reserveAmmo -= take; p.reloading = false; } }

    p.vy += GRAVITY; if (!moveX) p.vx *= 0.82;
    p.x += p.vx; handleCollisionsX(p); p.y += p.vy; handleCollisionsY(p);
    if (p.x < 10) p.x = 10; if (p.x + p.w > s.worldW - 10) p.x = s.worldW - 10 - p.w;
    if (p.y > WORLD_H + 100) damagePlayer(999);
    if (p.invuln > 0) p.invuln--;

    const targetCam = p.x + p.w / 2 - CANVAS_W / 2;
    s.cameraX += (targetCam - s.cameraX) * 0.12;
    s.cameraX = Math.max(0, Math.min(s.worldW - CANVAS_W, s.cameraX));

    // Enemies
    s.enemies.forEach(e => {
      const dx = p.x - e.x, dy = p.y - e.y, dist = Math.sqrt(dx * dx + dy * dy);
      const sees = dist < 400 && Math.abs(dy) < 220;
      if (sees || e.alertTimer > 0) {
        e.state = "engage"; e.alertTimer = Math.max(e.alertTimer - dt, 0); if (sees) e.alertTimer = 600;
        e.facing = dx > 0 ? 1 : -1;
        if (e.type === "dog") {
          // Dogs chase fast and jump
          e.vx += e.facing * 0.6; e.walkAnim += 0.35;
          if (dist < 30) damagePlayer(10);
          if (dy < -20 && e.onGround && Math.random() < 0.03) { e.vy = JUMP_FORCE; e.onGround = false; }
        } else if (e.type === "robot") {
          // Slow, tanky, keeps distance
          if (dist > 250) { e.vx += e.facing * 0.2; e.walkAnim += 0.15; }
          else if (dist < 120) { e.vx -= e.facing * 0.25; }
          else e.vx *= 0.9;
        } else {
          if (Math.abs(dx) > 180) { e.vx += e.facing * 0.3; e.walkAnim += 0.2; }
          else if (Math.abs(dx) < 100) { e.vx -= e.facing * 0.3; e.walkAnim += 0.2; }
          else { e.vx *= 0.85; e.walkAnim = 0; }
          if (dy < -40 && e.onGround && Math.random() < 0.02) { e.vy = JUMP_FORCE; e.onGround = false; }
        }
        const maxSpd = e.type === "dog" ? 4 : e.type === "robot" ? 1.5 : 2;
        e.vx = Math.max(-maxSpd, Math.min(maxSpd, e.vx));
        if (sees) shootEnemy(e, now);
      } else {
        e.state = "patrol"; e.patrolTimer -= dt;
        if (e.patrolTimer <= 0) { e.patrolDir = Math.random() < 0.5 ? -1 : 1; e.patrolTimer = 1000 + Math.random() * 2000; }
        e.vx += e.patrolDir * 0.1; e.vx = Math.max(-1, Math.min(1, e.vx)); e.facing = e.patrolDir; e.walkAnim += 0.1;
      }
      e.vy += GRAVITY; e.x += e.vx; handleCollisionsX(e); e.y += e.vy; handleCollisionsY(e);
      if (e.x < 10) { e.x = 10; e.patrolDir = 1; }
      if (e.x + e.w > s.worldW - 10) { e.x = s.worldW - 10 - e.w; e.patrolDir = -1; }
    });

    // Bullets
    for (let i = s.bullets.length - 1; i >= 0; i--) {
      const b = s.bullets[i]; b.x += b.vx; b.y += b.vy; b.life--;
      if (b.life <= 0 || b.x < -50 || b.x > s.worldW + 50 || b.y > WORLD_H + 50) { s.bullets.splice(i, 1); continue; }
      let hit = false;
      for (const pl of s.platforms) {
        if (pl.type === "platform") continue;
        if (b.x > pl.x && b.x < pl.x + pl.w && b.y > pl.y && b.y < pl.y + pl.h) { if (s.bulletHoles.length < 100) s.bulletHoles.push({ x: b.x, y: b.y, a: 1 }); hit = true; break; }
      }
      if (hit) { s.bullets.splice(i, 1); continue; }
      for (const pr of s.props) {
        if (pr.destroyed) continue;
        if (b.x > pr.x && b.x < pr.x + pr.w && b.y > pr.y && b.y < pr.y + pr.h) {
          if (pr.type !== "metal") damageProp(pr, b.damage);
          hit = true; break;
        }
      }
      if (hit) { s.bullets.splice(i, 1); continue; }
      if (!b.fromPlayer && aabb({ x: b.x - 2, y: b.y - 2, w: 4, h: 4 }, p)) { damagePlayer(b.damage); s.bullets.splice(i, 1); continue; }
      if (b.fromPlayer) {
        for (const e of s.enemies) {
          if (aabb({ x: b.x - 2, y: b.y - 2, w: 4, h: 4 }, e)) { damageEnemy(e, b.damage, b.y < e.y + 12); s.bullets.splice(i, 1); break; }
        }
      }
    }

    // Particles
    for (let i = s.particles.length - 1; i >= 0; i--) {
      const pa = s.particles[i]; pa.x += pa.vx; pa.y += pa.vy; if (pa.gravity) pa.vy += pa.gravity;
      if (pa.type === "smoke") { pa.vy -= 0.05; pa.vx *= 0.96; } pa.life--; if (pa.life <= 0) s.particles.splice(i, 1);
    }

    // Floating texts
    for (let i = s.floatingTexts.length - 1; i >= 0; i--) { const t = s.floatingTexts[i]; t.y += t.vy; t.life--; if (t.life <= 0) s.floatingTexts.splice(i, 1); }

    s.pickups.forEach(pk => (pk.bob += 0.08));
    for (let i = s.bulletHoles.length - 1; i >= 0; i--) { s.bulletHoles[i].a -= 0.0008; if (s.bulletHoles[i].a <= 0) s.bulletHoles.splice(i, 1); }
    if (s.comboTimer > 0) { s.comboTimer -= dt; if (s.comboTimer <= 0) s.combo = 0; }
    s.screenShake *= 0.85;

    // Win: all enemies dead + player walks into elevator zone (rightmost 150px of map)
    if (s.enemies.length === 0 && s.state === "playing") {
      const inElevator = p.x > s.worldW - 160; // very forgiving: last 160px = elevator zone
      if (inElevator) {
        s.state = "cleared"; s.clearedTime = now;
        s.score += 500;
        setHudState(h => ({ ...h, state: "cleared" }));
        playSfx('pickup');
      }
    }
  }

  /* ── Render ── */
  function render(ctx: CanvasRenderingContext2D, now: number) {
    const s = stateRef.current!;
    const theme = getFloorTheme(s.floor);
    const shakeX = (Math.random() - 0.5) * s.screenShake;
    const shakeY = (Math.random() - 0.5) * s.screenShake;

    // Background sky (night city)
    ctx.save();
    const grad = ctx.createLinearGradient(0, 0, 0, CANVAS_H);
    grad.addColorStop(0, theme.sky);
    grad.addColorStop(1, "#050510");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

    // City skyline parallax (far)
    ctx.save(); ctx.translate(-s.cameraX * 0.2, 0);
    ctx.fillStyle = "#080c16";
    for (let i = 0; i < 40; i++) { const bx = i * 120; const bh = 100 + (i % 7) * 30; ctx.fillRect(bx, CANVAS_H - 70 - bh, 80, bh); }
    ctx.restore();

    // Mid buildings
    ctx.save(); ctx.translate(-s.cameraX * 0.5, 0);
    ctx.fillStyle = "#0f1424";
    for (let i = 0; i < 35; i++) { const bx = i * 180 - 60; const bh = 150 + (i % 6) * 40; ctx.fillRect(bx, CANVAS_H - 60 - bh, 120, bh); }
    // Window lights
    ctx.fillStyle = "rgba(255,220,150,0.15)";
    for (let i = 0; i < 35; i++) { const bx = i * 180 - 60; const bh = 150 + (i % 6) * 40; for (let wy = 10; wy < bh - 10; wy += 20) { for (let wx = 8; wx < 110; wx += 18) { if ((wx + wy + i) % 5 < 2) ctx.fillRect(bx + wx, CANVAS_H - 60 - bh + wy, 10, 12); } } }
    ctx.restore();

    // Game world (camera)
    ctx.save(); ctx.translate(-s.cameraX + shakeX, shakeY);

    // Building walls (floors above/below) — draw back walls
    ctx.fillStyle = theme.wall;
    ctx.fillRect(0, 0, s.worldW, s.groundY);
    // Horizontal floor strips
    ctx.fillStyle = "#1a1a24";
    for (let sy = s.groundY - 50; sy > 0; sy -= 30) {
      ctx.globalAlpha = 0.3; ctx.fillRect(0, sy, s.worldW, 1); ctx.globalAlpha = 1;
    }

    // Bullet holes
    s.bulletHoles.forEach(h => { ctx.fillStyle = `rgba(0,0,0,${h.a})`; ctx.beginPath(); ctx.arc(h.x, h.y, 2.5, 0, Math.PI * 2); ctx.fill(); });

    // Platforms
    s.platforms.forEach(pl => {
      if (pl.type === "ground") { ctx.fillStyle = "#3a3a3a"; ctx.fillRect(pl.x, pl.y, pl.w, pl.h); ctx.fillStyle = theme.accent; ctx.fillRect(pl.x, pl.y, pl.w, 2); }
      else if (pl.type === "platform") { ctx.fillStyle = "#5a5a5a"; ctx.fillRect(pl.x, pl.y, pl.w, pl.h); ctx.fillStyle = theme.accent; ctx.fillRect(pl.x, pl.y, pl.w, 2); }
      else { ctx.fillStyle = "#4a4a50"; ctx.fillRect(pl.x, pl.y, pl.w, pl.h); ctx.fillStyle = "#222"; ctx.fillRect(pl.x, pl.y, 2, pl.h); ctx.fillRect(pl.x + pl.w - 2, pl.y, 2, pl.h); }
    });

    // Props
    s.props.forEach(pr => {
      if (pr.destroyed) return;
      if (pr.type === "drum") { ctx.fillStyle = "#aa1a1a"; ctx.fillRect(pr.x, pr.y, pr.w, pr.h); ctx.fillStyle = "#ff3333"; ctx.fillRect(pr.x + 2, pr.y + 2, pr.w - 4, 4); ctx.fillRect(pr.x + 2, pr.y + pr.h - 6, pr.w - 4, 4); }
      else if (pr.type === "crate") { ctx.fillStyle = "#8b5a2b"; ctx.fillRect(pr.x, pr.y, pr.w, pr.h); ctx.strokeStyle = "#5a3a1b"; ctx.lineWidth = 2; ctx.strokeRect(pr.x, pr.y, pr.w, pr.h); }
      else { ctx.fillStyle = "#777"; ctx.fillRect(pr.x, pr.y, pr.w, pr.h); ctx.fillStyle = "#555"; ctx.fillRect(pr.x, pr.y + pr.h - 4, pr.w, 4); }
    });

    // Pickups
    s.pickups.forEach(pk => {
      const yOff = Math.sin(pk.bob) * 3;
      if (pk.type === "weapon" && pk.weapon) { const w = WEAPONS[pk.weapon]; ctx.fillStyle = w.color; ctx.fillRect(pk.x, pk.y + yOff, pk.w, 6); ctx.fillStyle = "#222"; ctx.fillRect(pk.x + 4, pk.y + yOff + 6, 8, 4); ctx.fillStyle = "#fff"; ctx.font = "bold 8px monospace"; ctx.fillText("E", pk.x + 8, pk.y + yOff - 4); }
      else if (pk.type === "health") { ctx.fillStyle = "#cc0000"; ctx.fillRect(pk.x, pk.y + yOff, pk.w, pk.h); ctx.fillStyle = "#fff"; ctx.fillRect(pk.x + 8, pk.y + yOff + 3, 4, 14); ctx.fillRect(pk.x + 3, pk.y + yOff + 8, 14, 4); }
    });

    // Enemies
    s.enemies.forEach(e => drawEnemy(ctx, e, now));

    // Player
    drawPlayer(ctx, s.player, now);

    // Elevator
    drawElevator(ctx, s);

    // Bullets
    s.bullets.forEach(b => { ctx.strokeStyle = b.color; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(b.x, b.y); ctx.lineTo(b.x - b.vx * 0.6, b.y - b.vy * 0.6); ctx.stroke(); });

    // Particles
    s.particles.forEach(pa => {
      const a = pa.life / pa.maxLife;
      if (pa.type === "smoke") { ctx.fillStyle = `rgba(60,60,60,${a * 0.5})`; ctx.beginPath(); ctx.arc(pa.x, pa.y, pa.size * (2 - a), 0, Math.PI * 2); ctx.fill(); }
      else if (pa.type === "fire") { ctx.fillStyle = pa.color; ctx.globalAlpha = a; ctx.beginPath(); ctx.arc(pa.x, pa.y, pa.size * a, 0, Math.PI * 2); ctx.fill(); ctx.globalAlpha = 1; }
      else { ctx.fillStyle = pa.color; ctx.globalAlpha = a; ctx.fillRect(pa.x - 1, pa.y - 1, pa.size, pa.size); ctx.globalAlpha = 1; }
    });

    s.floatingTexts.forEach(t => { ctx.fillStyle = t.color; ctx.globalAlpha = Math.min(1, t.life / 40); ctx.font = "bold 12px monospace"; ctx.fillText(t.text, t.x, t.y); ctx.globalAlpha = 1; });

    ctx.restore(); // camera

    // Crosshair
    const mx = s.mouse.x, my = s.mouse.y;
    ctx.strokeStyle = "#ffd54a"; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(mx, my, 10, 0, Math.PI * 2);
    ctx.moveTo(mx - 14, my); ctx.lineTo(mx - 4, my); ctx.moveTo(mx + 4, my); ctx.lineTo(mx + 14, my);
    ctx.moveTo(mx, my - 14); ctx.lineTo(mx, my - 4); ctx.moveTo(mx, my + 4); ctx.lineTo(mx, my + 14); ctx.stroke();

    if (s.player.invuln > 0) { ctx.fillStyle = `rgba(255,0,0,${(s.player.invuln / 30) * 0.3})`; ctx.fillRect(0, 0, CANVAS_W, CANVAS_H); }

    // "All enemies dead — walk to elevator" hint
    if (s.enemies.length === 0 && s.state === "playing") {
      const inElev = s.player.x > s.worldW - 160;
      if (!inElev) {
        const pulse = 0.7 + Math.sin(performance.now() * 0.004) * 0.3;
        ctx.fillStyle = `rgba(0,255,100,${pulse})`;
        ctx.font = "bold 16px monospace";
        ctx.textAlign = "center";
        ctx.fillText("► ALL CLEAR — HEAD TO ELEVATOR → → →", CANVAS_W / 2, 40);
        ctx.textAlign = "left";
      }
    }

    // Intro
    if (s.state === "intro") drawIntro(ctx, s.introTime, s.floor);
    ctx.restore();
  }

  function drawPlayer(ctx: CanvasRenderingContext2D, p: Player, now: number) {
    ctx.save();
    if (p.invuln > 0 && Math.floor(now / 60) % 2 === 0) ctx.globalAlpha = 0.5;
    // Shadow
    ctx.fillStyle = "rgba(0,0,0,0.4)"; ctx.beginPath(); ctx.ellipse(p.x + p.w / 2, p.y + p.h, 14, 4, 0, 0, Math.PI * 2); ctx.fill();
    const legSwing = Math.sin(p.walkAnim) * 6;

    // Legs (black pants)
    ctx.fillStyle = "#111"; ctx.fillRect(p.x + 4, p.y + 30, 6, 14 + (legSwing > 0 ? legSwing : 0)); ctx.fillRect(p.x + 14, p.y + 30, 6, 14 + (legSwing < 0 ? -legSwing : 0));
    // Body (black suit)
    ctx.fillStyle = "#1a1a1a"; ctx.fillRect(p.x + 2, p.y + 14, 20, 20);
    // White shirt + tie
    ctx.fillStyle = "#fff"; ctx.fillRect(p.x + 10, p.y + 14, 4, 20);
    ctx.fillStyle = "#333"; ctx.fillRect(p.x + 10, p.y + 16, 4, 4);
    // Head
    ctx.fillStyle = AGENT.headColor; ctx.fillRect(p.x + 5, p.y, 14, 14);
    // Hat (black fedora)
    ctx.fillStyle = "#111"; ctx.fillRect(p.x + 3, p.y - 3, 18, 5); ctx.fillRect(p.x + 6, p.y - 6, 12, 4);
    // Sunglasses
    ctx.fillStyle = "#000"; ctx.fillRect(p.x + 6, p.y + 4, 12, 3);

    // Weapon
    const w = WEAPONS[p.weapon];
    const wx = p.x + p.w / 2 + p.facing * 6, wy = p.y + 20;
    const s = stateRef.current!;
    let angle: number;
    if (s.touchShoot) angle = p.facing > 0 ? 0 : Math.PI;
    else { const tx = s.mouse.x + s.cameraX; const ty = s.mouse.y; angle = Math.atan2(ty - wy, tx - wx); }
    ctx.save(); ctx.translate(wx, wy); ctx.rotate(angle);
    ctx.fillStyle = "#2a2a2a"; const gl = w.id === "ak47" || w.id === "smg" ? 22 : w.id === "sniper" ? 26 : w.id === "rpg" ? 24 : 16;
    ctx.fillRect(0, -2, gl, 4); ctx.fillStyle = w.color; ctx.fillRect(gl - 4, -3, 4, 6);
    ctx.restore();

    if (p.reloading) { const w2 = WEAPONS[p.weapon]; const prog = Math.min(1, (performance.now() - p.reloadStart) / w2.reloadTime); ctx.fillStyle = "rgba(0,0,0,0.6)"; ctx.fillRect(p.x - 4, p.y - 14, 32, 6); ctx.fillStyle = "#ffd54a"; ctx.fillRect(p.x - 3, p.y - 13, 30 * prog, 4); }
    ctx.restore();
  }

  function drawEnemy(ctx: CanvasRenderingContext2D, e: Enemy, _now: number) {
    ctx.save();
    ctx.fillStyle = "rgba(0,0,0,0.4)"; ctx.beginPath(); ctx.ellipse(e.x + e.w / 2, e.y + e.h, e.w / 2, 4, 0, 0, Math.PI * 2); ctx.fill();

    if (e.type === "dog") {
      // Dog body
      const legSwing = Math.sin(e.walkAnim) * 3;
      ctx.fillStyle = "#5a3a1a"; ctx.fillRect(e.x + 2, e.y + 10, 16, 8); // body
      ctx.fillStyle = "#4a2a0a"; ctx.fillRect(e.x, e.y + 12 + legSwing, 6, 4); ctx.fillRect(e.x + 14, e.y + 12 - legSwing, 6, 4); // legs
      ctx.fillStyle = "#3a1a00"; ctx.fillRect(e.x + (e.facing > 0 ? 16 : -4), e.y + 4, 8, 6); // head
      ctx.fillStyle = "#ff0000"; ctx.fillRect(e.x + (e.facing > 0 ? 18 : 0), e.y + 5, 3, 2); // eyes
      ctx.fillStyle = "#cc0000"; ctx.fillRect(e.x + (e.facing > 0 ? 20 : -2), e.y + 6, 2, 2); // eyes
    } else if (e.type === "robot") {
      // Giant robot
      ctx.fillStyle = "#555"; ctx.fillRect(e.x, e.y, e.w, e.h); // body
      ctx.fillStyle = "#777"; ctx.fillRect(e.x + 4, e.y + 2, e.w - 8, 6); // head
      ctx.fillStyle = "#ff0000"; ctx.fillRect(e.x + (e.facing > 0 ? 24 : 8), e.y + 3, 4, 3); // eye
      ctx.fillStyle = "#444"; ctx.fillRect(e.x + 4, e.y + 14, e.w - 8, e.h - 18); // chest
      ctx.fillStyle = "#666"; ctx.fillRect(e.x + 6, e.y + 24, 24, 4); // arms
      ctx.fillStyle = "#333"; ctx.fillRect(e.x, e.y + e.h - 6, e.w, 6); // feet
      // Armour plate
      ctx.fillStyle = "#888"; ctx.fillRect(e.x + 10, e.y + 16, 16, 6);
    } else {
      // Worker (yellow suit)
      const legSwing = Math.sin(e.walkAnim) * 5;
      ctx.fillStyle = "#3a2a1a"; ctx.fillRect(e.x + 4, e.y + 30, 6, 14 + (legSwing > 0 ? legSwing : 0)); ctx.fillRect(e.x + 14, e.y + 30, 6, 14 + (legSwing < 0 ? -legSwing : 0));
      ctx.fillStyle = "#ffcc22"; ctx.fillRect(e.x + 2, e.y + 14, 20, 20);
      ctx.fillStyle = "#fff5cc"; ctx.fillRect(e.x + 2, e.y + 20, 20, 2); ctx.fillRect(e.x + 2, e.y + 28, 20, 2);
      ctx.fillStyle = "#c89d7a"; ctx.fillRect(e.x + 5, e.y + 4, 14, 12);
      ctx.fillStyle = e.helmet; ctx.fillRect(e.x + 4, e.y, 16, 6); ctx.fillRect(e.x + 3, e.y + 4, 18, 2);
      ctx.fillStyle = "#000"; ctx.fillRect(e.x + (e.facing > 0 ? 13 : 7), e.y + 8, 2, 2);
    }

    // Health bar
    const barW = e.w + 2; const hpPct = e.hp / e.maxHp;
    ctx.fillStyle = "rgba(0,0,0,0.6)"; ctx.fillRect(e.x - 1, e.y - 8, barW, 4);
    ctx.fillStyle = hpPct > 0.5 ? "#66ff66" : hpPct > 0.25 ? "#ffaa00" : "#ff3333";
    ctx.fillRect(e.x, e.y - 7, barW * hpPct, 2);
    if (e.state === "engage") { ctx.fillStyle = "#ff3333"; ctx.font = "bold 12px monospace"; ctx.fillText("!", e.x + 10, e.y - 12); }
    ctx.restore();
  }

  function drawElevator(ctx: CanvasRenderingContext2D, s: NonNullable<typeof stateRef.current>) {
    const ex = s.elevX, ey = s.groundY - 100;
    const cleared = s.enemies.length === 0;

    // Beacon glow when cleared
    if (cleared) {
      const glow = ctx.createRadialGradient(ex + 40, ey + 50, 8, ex + 40, ey + 50, 90);
      glow.addColorStop(0, 'rgba(0,255,100,0.5)');
      glow.addColorStop(0.5, 'rgba(0,255,100,0.15)');
      glow.addColorStop(1, 'rgba(0,255,100,0)');
      ctx.fillStyle = glow;
      ctx.fillRect(ex - 70, ey - 40, 220, 190);
      const pulse = 0.5 + Math.sin(performance.now() * 0.005) * 0.5;
      ctx.fillStyle = `rgba(0,255,100,${pulse * 0.3})`;
      ctx.fillRect(ex - 40, ey - 20, 160, 150);
    }

    // Elevator cabin (open front — no front wall, just frame and back)
    // Back wall
    ctx.fillStyle = "#2a2a2a";
    ctx.fillRect(ex + 70, ey, 10, 100);
    // Side walls
    ctx.fillStyle = "#444";
    ctx.fillRect(ex, ey, 4, 100);
    ctx.fillRect(ex + 76, ey, 4, 100);
    // Top frame
    ctx.fillStyle = "#555";
    ctx.fillRect(ex, ey - 3, 80, 4);
    // Floor
    ctx.fillStyle = "#555";
    ctx.fillRect(ex, ey + 97, 80, 5);

    // Ceiling light
    ctx.fillStyle = cleared ? `rgba(0,255,100,${0.6 + Math.sin(performance.now()*0.008)*0.4})` : "rgba(255,100,100,0.4)";
    ctx.fillRect(ex + 30, ey + 6, 20, 3);

    // Arrow indicator on floor
    ctx.fillStyle = cleared ? "#00ff88" : "#ff4444";
    ctx.font = "bold 16px monospace";
    ctx.fillText(cleared ? "▲" : "🔒", ex + 30, ey + 55);

    // Label
    ctx.fillStyle = cleared ? "#00ff88" : "#ccc";
    ctx.font = "bold 10px monospace";
    ctx.fillText("ELEVATOR", ex + 8, ey - 7);
    if (cleared) {
      const pulse2 = 0.6 + Math.sin(performance.now() * 0.006) * 0.4;
      ctx.fillStyle = `rgba(0,255,100,${pulse2})`;
      ctx.font = "bold 11px monospace";
      ctx.fillText("ENTER →", ex + 18, ey + 92);
      // Big pulsing arrow on ground
      ctx.font = "bold 28px monospace";
      ctx.fillText("⬇", ex + 28, ey + 70 + Math.sin(performance.now() * 0.005) * 4);
    }
  }

  function drawIntro(ctx: CanvasRenderingContext2D, t: number, fl: number) {
    ctx.fillStyle = "rgba(0,0,0,0.75)"; ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
    const fade = Math.min(1, t / 600);
    ctx.globalAlpha = fade;

    const theme = getFloorTheme(fl);
    // Floor indicator (like elevator panel)
    ctx.fillStyle = "#1a1a1a"; ctx.fillRect(CANVAS_W / 2 - 100, 80, 200, 50);
    ctx.fillStyle = theme.accent; ctx.font = "bold 14px monospace"; ctx.textAlign = "center";
    ctx.fillText("▣ FLOOR ▣", CANVAS_W / 2, 100);
    ctx.fillStyle = "#fff"; ctx.font = "bold 48px monospace";
    ctx.fillText(String(fl).padStart(2, "0"), CANVAS_W / 2, 135);

    ctx.fillStyle = "#fff"; ctx.font = "bold 24px monospace";
    ctx.fillText(theme.name.toUpperCase(), CANVAS_W / 2, 200);

    // Agent emoji
    ctx.font = "80px sans-serif"; ctx.fillText("🕵️", CANVAS_W / 2, 290);
    ctx.fillStyle = "#fff"; ctx.font = "bold 14px monospace";
    ctx.fillText("AGENT BYTON", CANVAS_W / 2, 330);
    ctx.fillStyle = "#ccc"; ctx.font = "12px monospace";
    ctx.fillText(`Enemies: ${getEnemyCount(fl)}  |  Weapon: Dual Desert Eagles`, CANVAS_W / 2, 350);

    if (t > 1500) {
      const blink = Math.floor(t / 400) % 2;
      if (blink) { ctx.fillStyle = theme.accent; ctx.font = "bold 18px monospace"; ctx.fillText("▶ PRESS SPACE / ENTER TO START ◀", CANVAS_W / 2, 480); }
    }
    ctx.textAlign = "left"; ctx.globalAlpha = 1;
  }

  /* ── Loop ── */
  useEffect(() => {
    const canvas = canvasRef.current; if (!canvas) return;
    const ctx = canvas.getContext("2d")!;
    let rafId = 0, lastTime = performance.now(), hudCounter = 0;

    const loop = (now: number) => {
      const dt = Math.min(40, now - lastTime); lastTime = now;
      const s = stateRef.current; if (!s) { rafId = requestAnimationFrame(loop); return; }

      if (!s.paused && s.state === "intro") { s.introTime += dt; if (s.introTime > 4000 || s.keys[" "] || s.keys["enter"]) { s.state = "playing"; setHudState(h => ({ ...h, state: "playing" })); } }
      if (!s.paused && s.state === "playing") updateGame(now, dt);
      if (!s.paused && s.state === "cleared") { s.elevatorTime += dt; }

      render(ctx, now);

      hudCounter += dt;
      if (hudCounter > 100) {
        hudCounter = 0;
        const p = s.player; const w = WEAPONS[p.weapon];
        setHudState(h => ({ ...h, hp: Math.max(0, Math.floor(p.hp)), maxHp: p.maxHp, ammo: p.ammo, reserve: p.reserveAmmo, weapon: w.name, floor: s.floor, score: s.score, enemies: s.enemies.length, state: s.state, reloading: p.reloading }));
      }

      rafId = requestAnimationFrame(loop);
    };
    rafId = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafId);
  }, []);

  /* ── Touch Handlers ── */
  const holdKey = (key: string) => ({
    onTouchStart: (e: React.TouchEvent) => { e.preventDefault(); if (stateRef.current) stateRef.current.keys[key] = true; },
    onTouchEnd: (e: React.TouchEvent) => { e.preventDefault(); if (stateRef.current) stateRef.current.keys[key] = false; },
    onTouchCancel: (e: React.TouchEvent) => { e.preventDefault(); if (stateRef.current) stateRef.current.keys[key] = false; },
    onMouseDown: (e: React.MouseEvent) => { e.preventDefault(); if (stateRef.current) stateRef.current.keys[key] = true; },
    onMouseUp: (e: React.MouseEvent) => { e.preventDefault(); if (stateRef.current) stateRef.current.keys[key] = false; },
    onMouseLeave: () => { if (stateRef.current) stateRef.current.keys[key] = false; },
  });
  const tapAction = (fn: () => void) => ({
    onTouchStart: (e: React.TouchEvent) => { e.preventDefault(); fn(); },
    onMouseDown: (e: React.MouseEvent) => { e.preventDefault(); fn(); },
  });
  const shootBtnHandlers = {
    onTouchStart: (e: React.TouchEvent) => { e.preventDefault(); if (stateRef.current) stateRef.current.touchShoot = true; },
    onTouchEnd: (e: React.TouchEvent) => { e.preventDefault(); if (stateRef.current) stateRef.current.touchShoot = false; },
    onTouchCancel: (e: React.TouchEvent) => { e.preventDefault(); if (stateRef.current) stateRef.current.touchShoot = false; },
    onMouseDown: (e: React.MouseEvent) => { e.preventDefault(); if (stateRef.current) stateRef.current.touchShoot = true; },
    onMouseUp: (e: React.MouseEvent) => { e.preventDefault(); if (stateRef.current) stateRef.current.touchShoot = false; },
    onMouseLeave: () => { if (stateRef.current) stateRef.current.touchShoot = false; },
  };
  const toggleMenu = () => setHudState(h => { const open = !h.menuOpen; if (stateRef.current) stateRef.current.paused = open; return { ...h, menuOpen: open, paused: open }; });
  const closeMenu = () => setHudState(h => { if (stateRef.current) stateRef.current.paused = false; return { ...h, menuOpen: false, paused: false }; });

  return (
    <div className="min-h-screen w-full bg-black text-white flex flex-col items-center justify-center p-2 font-mono select-none">
      {/* Top bar HUD */}
      <div className="w-full max-w-[960px] flex items-center justify-between mb-2 px-2 text-xs">
        <div className="flex items-center gap-3">
          <button onClick={() => onExit(hudState.floor)} className="px-3 py-1 bg-zinc-800 border border-zinc-700 rounded hover:bg-zinc-700 text-xs">← MENU</button>
          <span className="text-white font-bold">FLOOR {hudState.floor}/{MAX_FLOOR}</span>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-green-400">SCORE: {hudState.score.toLocaleString()}</span>
          <span className="text-red-400">ENEMIES: {hudState.enemies}</span>
        </div>
      </div>

      {/* Canvas */}
      <div className="relative w-full max-w-[960px]" style={{ aspectRatio: "16/9" }}>
        <canvas ref={canvasRef} width={CANVAS_W} height={CANVAS_H} className="w-full h-full block border-2 border-white/30 rounded-lg bg-black cursor-crosshair" tabIndex={0} />

        {/* Hamburger — top LEFT */}
        <button onClick={toggleMenu} className="absolute top-2 left-2 w-10 h-10 bg-black/70 border-2 border-white/40 rounded-md flex flex-col items-center justify-center gap-[3px] hover:bg-black/90 backdrop-blur-sm z-30" aria-label="Menu">
          <span className="block w-4 h-[2px] bg-white rounded"></span>
          <span className="block w-4 h-[2px] bg-white rounded"></span>
          <span className="block w-4 h-[2px] bg-white rounded"></span>
        </button>

        {/* TOP-RIGHT — Health & Ammo bars (no black labels, just bars) */}
        <div className="absolute top-2 right-2 flex flex-col gap-1.5 pointer-events-none z-20">
          {/* HP bar */}
          <div className="h-2.5 w-36 bg-zinc-900/80 rounded-full overflow-hidden border border-white/20 shadow-sm">
            <div className="h-full bg-gradient-to-r from-red-600 via-red-500 to-red-400 transition-all rounded-full" style={{ width: `${(hudState.hp / hudState.maxHp) * 100}%` }} />
          </div>
          {/* Ammo bar */}
          <div className="h-2.5 w-36 bg-zinc-900/80 rounded-full overflow-hidden border border-white/20 shadow-sm">
            <div
              className="h-full bg-gradient-to-r from-yellow-500 via-yellow-400 to-yellow-300 transition-all rounded-full"
              style={{ width: `${hudState.reloading ? 0 : (hudState.reserve + hudState.ammo > 0 ? (hudState.ammo / (hudState.reserve + hudState.ammo || 1)) * 100 : 0)}%` }}
            />
          </div>
        </div>

        {/* Bottom-left HUD — weapon name + ammo text */}
        {hudState.state === "playing" && <div className="absolute bottom-2 left-2 pointer-events-none text-[11px]">
          <span className="text-white font-bold">{hudState.weapon}</span>
          <span className="text-zinc-400 ml-2">
            {hudState.reloading ? <span className="text-orange-400 animate-pulse">RELOADING...</span> : <>{hudState.ammo}/{hudState.reserve}</>}
          </span>
        </div>}

        {/* Bottom-right — character badge (mini) */}
        <div className="absolute bottom-2 right-2 pointer-events-none flex items-center gap-1.5 text-xs">
          <span className="text-lg">🕵️</span>
          <span className="text-white font-bold">{AGENT.name}</span>
        </div>

        {/* Mobile controls */}
        {hudState.state === "playing" && !hudState.menuOpen && (
          <div className="absolute inset-0 pointer-events-none z-20 select-none" style={{ touchAction: "none" }}>
            <div className="absolute bottom-3 left-3 flex gap-2 pointer-events-auto">
              <button {...holdKey("a")} className="w-14 h-14 sm:w-16 sm:h-16 bg-black/60 border-2 border-white/50 rounded-full flex items-center justify-center text-white text-3xl font-black active:bg-white/20 active:scale-95 backdrop-blur-sm shadow-lg" aria-label="Left">◀</button>
              <button {...holdKey("d")} className="w-14 h-14 sm:w-16 sm:h-16 bg-black/60 border-2 border-white/50 rounded-full flex items-center justify-center text-white text-3xl font-black active:bg-white/20 active:scale-95 backdrop-blur-sm shadow-lg" aria-label="Right">▶</button>
            </div>
            <div className="absolute bottom-20 left-3 pointer-events-auto">
              <button {...holdKey("shift")} className="w-12 h-12 bg-black/60 border-2 border-blue-400/60 rounded-full flex items-center justify-center text-blue-300 text-[10px] font-black active:bg-blue-500/30 active:scale-95 backdrop-blur-sm shadow-lg" aria-label="Sprint">⚡<br/>RUN</button>
            </div>
            <div className="absolute bottom-3 right-3 pointer-events-auto">
              <div className="relative flex items-end gap-2">
                <div className="flex flex-col gap-2 mb-2">
                  <button {...tapAction(tryPickup)} className="w-12 h-12 bg-black/60 border-2 border-green-400/60 rounded-full flex flex-col items-center justify-center text-green-300 text-[9px] font-black active:bg-green-500/30 active:scale-95 backdrop-blur-sm shadow-lg leading-tight" aria-label="Pickup"><span className="text-base leading-none">✋</span><span>PICK</span></button>
                  <button {...tapAction(switchWeapon)} className="w-12 h-12 bg-black/60 border-2 border-cyan-400/60 rounded-full flex flex-col items-center justify-center text-cyan-300 text-[9px] font-black active:bg-cyan-500/30 active:scale-95 backdrop-blur-sm shadow-lg leading-tight" aria-label="Switch Weapon"><span className="text-base leading-none">🔄</span><span>SWAP</span></button>
                  <button {...tapAction(tryReload)} className="w-12 h-12 bg-black/60 border-2 border-orange-400/60 rounded-full flex flex-col items-center justify-center text-orange-300 text-[9px] font-black active:bg-orange-500/30 active:scale-95 backdrop-blur-sm shadow-lg leading-tight" aria-label="Reload"><span className="text-base leading-none">🔁</span><span>RELOAD</span></button>
                </div>
                <div className="flex flex-col gap-2 items-center">
                  <button {...holdKey(" ")} className="w-14 h-14 sm:w-16 sm:h-16 bg-black/60 border-2 border-white/50 rounded-full flex flex-col items-center justify-center text-white font-black active:bg-white/20 active:scale-95 backdrop-blur-sm shadow-lg" aria-label="Jump">
                    <span className="text-2xl leading-none">⬆</span><span className="text-[9px]">JUMP</span>
                  </button>
                  <button {...shootBtnHandlers} className="w-20 h-20 sm:w-24 sm:h-24 bg-gradient-to-br from-red-600 to-orange-500 border-2 border-yellow-300 rounded-full flex flex-col items-center justify-center text-white font-black active:scale-95 shadow-xl shadow-red-500/40" aria-label="Shoot">
                    <span className="text-3xl sm:text-4xl leading-none">🔥</span><span className="text-[10px] tracking-widest">FIRE</span>
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Menu panel */}
        {hudState.menuOpen && (
          <div className="absolute inset-0 bg-black/85 backdrop-blur-md flex items-center justify-center z-40 p-4">
            <div className="bg-zinc-900 border-2 border-white/40 rounded-xl p-6 max-w-sm w-full shadow-2xl">
              <h2 className="text-2xl font-black text-white text-center mb-1 tracking-widest">☰ GAME MENU</h2>
              <div className="text-center text-xs text-zinc-400 mb-5">Floor {hudState.floor}/{MAX_FLOOR} • Score {hudState.score.toLocaleString()}</div>
              <div className="space-y-2">
                <button onClick={closeMenu} className="w-full py-3 rounded-lg bg-white text-black font-black tracking-wider border-2 border-white hover:scale-[1.02] active:scale-95">▶ RESUME</button>
                <button onClick={() => { closeMenu(); initFloor(hudState.floor, hudState.score); }} className="w-full py-3 rounded-lg bg-zinc-800 text-white font-bold tracking-wider border-2 border-zinc-700 hover:border-white/40">↺ RESTART FLOOR</button>
                <button onClick={() => onExit(hudState.floor)} className="w-full py-3 rounded-lg bg-red-900/60 text-red-300 font-bold tracking-wider border-2 border-red-700/60 hover:bg-red-900/80">✕ EXIT TO MAIN MENU</button>
              </div>
              <div className="mt-5 pt-4 border-t border-zinc-700 text-[10px] text-zinc-500 text-center space-y-1"><div>📧 help@sirbyton.site</div><div>🌐 zimdev.shop</div></div>
            </div>
          </div>
        )}

        {/* Pause */}
        {hudState.paused && !hudState.menuOpen && hudState.state === "playing" && (
          <div className="absolute inset-0 bg-black/80 backdrop-blur-sm flex flex-col items-center justify-center rounded-lg">
            <h2 className="text-4xl font-black text-white mb-4">⏸ PAUSED</h2>
            <div className="text-sm text-zinc-300 mb-4">Press P or ESC to resume</div>
          </div>
        )}

        {/* Floor Cleared — Elevator Choice */}
        {hudState.state === "cleared" && (
          <div className="absolute inset-0 bg-black/85 backdrop-blur-md flex items-center justify-center z-40 p-4">
            <div className="bg-zinc-900 border-2 border-green-400/60 rounded-xl p-6 max-w-md w-full shadow-2xl shadow-green-500/20 text-center">
              <div className="text-green-400 text-sm mb-2 tracking-widest">▣ FLOOR {hudState.floor} CLEARED ▣</div>
              <h2 className="text-4xl font-black text-white mb-3">🏗️ FLOOR SECURED!</h2>
              <div className="text-sm text-zinc-300 mb-2">All {getEnemyCount(hudState.floor)} enemies eliminated!</div>
              <div className="text-sm text-zinc-300 mb-2">Score: <span className="text-green-400 font-bold">{hudState.score.toLocaleString()}</span></div>
              <div className="text-xs text-zinc-400 mb-4">The elevator is now unlocked. Choose your next move:</div>
              <div className="space-y-2">
                {hudState.floor < MAX_FLOOR ? (
                  <>
                    <button onClick={nextFloor} className="w-full py-3 rounded-lg bg-gradient-to-r from-green-600 to-emerald-500 text-black font-black tracking-widest border-2 border-green-300 hover:scale-[1.02] active:scale-95">
                      🛗 ENTER ELEVATOR — GO TO FLOOR {hudState.floor + 1}
                    </button>
                    <button onClick={() => { initFloor(hudState.floor, hudState.score); }} className="w-full py-3 rounded-lg bg-zinc-800 text-white font-bold tracking-wider border-2 border-zinc-700 hover:border-white/40">
                      ↺ PLAY FLOOR {hudState.floor} AGAIN
                    </button>
                  </>
                ) : (
                  <button onClick={nextFloor} className="w-full py-3 rounded-lg bg-gradient-to-r from-yellow-500 to-yellow-300 text-black font-black tracking-widest border-2 border-yellow-200 hover:scale-[1.02] active:scale-95">
                    🏆 FINAL FLOOR — CLAIM VICTORY!
                  </button>
                )}
                <button onClick={() => onExit(hudState.floor)} className="w-full py-3 rounded-lg bg-zinc-800 text-zinc-300 font-bold tracking-wider border-2 border-zinc-700 hover:border-white/40">
                  ← MAIN MENU
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Complete */}
        {hudState.state === "complete" && (
          <div className="absolute inset-0 bg-black/90 backdrop-blur-md flex items-center justify-center z-40 p-4">
            <div className="bg-zinc-900 border-2 border-yellow-400/60 rounded-xl p-6 max-w-md w-full shadow-2xl shadow-yellow-500/25 text-center">
              <div className="text-6xl mb-4">🏆</div>
              <h2 className="text-4xl font-black text-yellow-400 mb-2">ALL FLOORS CLEARED!</h2>
              <div className="text-zinc-300 mb-2">Agent Byton has secured the entire skyscraper!</div>
              <div className="text-sm text-zinc-300 mb-4">Final Score: <span className="text-yellow-400 font-bold">{hudState.score.toLocaleString()}</span></div>
              <div className="space-y-2">
                <button onClick={() => { initFloor(1, 0); }} className="w-full py-3 rounded-lg bg-white text-black font-black tracking-widest border-2 border-white hover:scale-[1.02] active:scale-95">↺ NEW GAME+</button>
                <button onClick={() => onExit(MAX_FLOOR)} className="w-full py-3 rounded-lg bg-zinc-800 text-zinc-300 font-bold tracking-wider border-2 border-zinc-700 hover:border-white/40">← MAIN MENU</button>
              </div>
            </div>
          </div>
        )}

        {/* Lost */}
        {hudState.state === "lost" && (
          <div className="absolute inset-0 bg-black/85 backdrop-blur-md flex items-center justify-center z-40 p-4">
            <div className="bg-zinc-900 border-2 border-red-500/60 rounded-xl p-6 max-w-md w-full shadow-2xl text-center">
              <div className="text-red-400 text-sm mb-2 tracking-widest">▣ MISSION FAILED ▣</div>
              <h2 className="text-5xl font-black text-red-500 mb-4">AGENT DOWN</h2>
              <div className="text-sm text-zinc-300 mb-4">Score: <span className="text-yellow-400 font-bold">{hudState.score.toLocaleString()}</span></div>
              <div className="space-y-2">
                <button onClick={() => { initFloor(hudState.floor, Math.max(0, hudState.score - 500)); }} className="w-full py-3 rounded-lg bg-gradient-to-r from-red-600 to-orange-500 text-white font-black tracking-widest border-2 border-red-400 hover:scale-[1.02] active:scale-95">↺ RETRY FLOOR {hudState.floor}</button>
                <button onClick={() => onExit(hudState.floor)} className="w-full py-3 rounded-lg bg-zinc-800 text-zinc-300 font-bold tracking-wider border-2 border-zinc-700 hover:border-white/40">← MAIN MENU</button>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Controls reminder */}
      <div className="w-full max-w-[960px] mt-2 px-2 text-[10px] text-zinc-500 flex justify-center gap-4 flex-wrap">
        <span><kbd className="text-white">WASD</kbd> Move</span>
        <span><kbd className="text-white">SPACE</kbd> Jump</span>
        <span><kbd className="text-white">CLICK</kbd> Shoot</span>
        <span><kbd className="text-white">R</kbd> Reload</span>
        <span><kbd className="text-white">E</kbd> Pickup</span>
        <span><kbd className="text-white">Q</kbd> Switch</span>
        <span><kbd className="text-white">SHIFT</kbd> Sprint</span>
        <span><kbd className="text-white">P</kbd> Pause</span>
        <span className="text-cyan-400">📱 Touch controls on-screen</span>
      </div>

      <style>{`
        .btn-game{background:linear-gradient(to right,#dc2626,#f59e0b);color:#000;font-weight:900;padding:.6rem 1.4rem;border:2px solid #fbbf24;border-radius:.5rem;letter-spacing:.1em;transition:all .15s;}
        .btn-game:hover{box-shadow:0 0 20px rgba(251,191,36,.4);transform:scale(1.03);}
        .btn-game-secondary{background:#27272a;color:#fff;font-weight:700;padding:.6rem 1.4rem;border:2px solid #52525b;border-radius:.5rem;letter-spacing:.1em;}
        kbd{padding:1px 5px;background:#18181b;border:1px solid #3f3f46;border-radius:3px;font-size:10px;}
      `}</style>
    </div>
  );
}
