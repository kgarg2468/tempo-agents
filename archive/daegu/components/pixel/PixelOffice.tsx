"use client";

/**
 * PixelOffice — pixel-art office that animates in real time based on
 * the entity list passed in.
 *
 * Sprites and the 7-frame layout convention (walk × 3 + type × 2 +
 * read × 2 per direction; rows = down/up/right with left flipped from
 * right) plus all furniture / floor / wall sprites are derived from the
 * MIT-licensed pixel-agents project — see public/assets/pixel/NOTICE.md.
 *
 * Layout: a 30×18 tile world split into three rooms by a navy wall:
 *   - Work area (left): wood floor, four desk-with-PC stations,
 *     bookshelves on the top wall, plants by the entrance.
 *   - Kitchen (top-right): tile floor, coffee machine + bin + clock.
 *   - Meeting room (bottom-right): blue carpet, two sofas around a
 *     coffee table, painting on the wall, plants in the corners.
 *
 * Walls are dark navy filled rectangles; the engine doesn't use the
 * 16-bitmask wall atlas because for this static layout solid fills
 * look cleaner. Doorways are explicit gaps in the wall fill.
 */
import { useEffect, useMemo, useRef, useState } from "react";

export type EntityStatus = "active" | "pending" | "fired" | "spared";

export interface OfficeEntity {
  id: string;
  name: string;
  kind: "employee" | "worker";
  status: EntityStatus | "in_progress" | "waiting_input" | "done" | "failed";
  paletteIdx: number;
  busy?: boolean;
}

// ── Layout constants ─────────────────────────────────────────────
const TILE = 16;
const ZOOM = 3;
const COLS = 30;
const ROWS = 18;
const CANVAS_W = COLS * TILE * ZOOM;
const CANVAS_H = ROWS * TILE * ZOOM;

const CHAR_FRAME_W = 16;
const CHAR_FRAME_H = 32;
const CHAR_SHEET_COUNT = 6;

const WALK_SPEED_TILES_PER_SEC = 2.4;
const WALK_FRAME_DURATION = 0.18;
const TYPE_FRAME_DURATION = 0.32;

type Dir = "down" | "up" | "right" | "left";
type AnimState = "idle" | "walk" | "type";

interface Character {
  id: string;
  name: string;
  paletteIdx: number;
  x: number;
  y: number;
  targetCol: number;
  targetRow: number;
  dir: Dir;
  anim: AnimState;
  frame: number;
  frameTimer: number;
  tint?: "fired" | "court" | null;
}

// ── Room layout ──────────────────────────────────────────────────

const WORK_ROOM = { c0: 1, r0: 1, c1: 14, r1: 17 };
const KITCHEN = { c0: 16, r0: 1, c1: 29, r1: 7 };
const MEETING = { c0: 16, r0: 8, c1: 29, r1: 17 };

interface Rect {
  c: number;
  r: number;
  w: number;
  h: number;
}
const WALL_FILLS: Rect[] = [
  { c: 0, r: 0, w: COLS, h: 1 },
  { c: 0, r: ROWS - 1, w: COLS, h: 1 },
  { c: 0, r: 0, w: 1, h: ROWS },
  { c: COLS - 1, r: 0, w: 1, h: ROWS },
  // Vertical divider work | (kitchen + meeting), with two doorway gaps.
  { c: 14, r: 1, w: 2, h: 4 },
  { c: 14, r: 6, w: 2, h: 5 },
  { c: 14, r: 12, w: 2, h: 5 },
  // Horizontal divider kitchen | meeting.
  { c: 16, r: 7, w: 13, h: 1 },
];

const EXIT_DOOR = { col: COLS - 2, row: ROWS - 2 };
const DOOR_HIGHLIGHTS: Rect[] = [
  { c: 14, r: 5, w: 2, h: 1 },
  { c: 14, r: 11, w: 2, h: 1 },
];

// Court tiles sit on the carpet just below the painting, before the
// sofas and coffee table at row 11+.
const COURT_TILES = [
  { col: 21, row: 9 },
  { col: 22, row: 9 },
  { col: 23, row: 9 },
];

// Per-room floor tints applied via canvas `multiply` composite over the
// grayscale floor tile, so we get warm wood / cool carpet from a single
// gray sprite atlas.
const FLOOR_TINTS: Record<FloorKind, string | null> = {
  wood: "#a07a48",   // warm brown
  tile: "#f0ece4",   // pale cream — barely shifts the gray
  carpet: "#5d7392", // muted slate-blue
  wall: null,
};

// Characters sit one tile SOUTH of the desk so their torso is visible
// "behind" the desk surface and their feet rest on the chair tile.
const EMPLOYEE_DESKS = [
  { col: 4, row: 9 },
  { col: 8, row: 9 },
  { col: 4, row: 14 },
  { col: 8, row: 14 },
];

// Workers cluster on the right side of the work room near the divider.
const WORKER_DESKS = [
  { col: 11, row: 9 },
  { col: 12, row: 14 },
  { col: 11, row: 14 },
  { col: 12, row: 9 },
];

function targetFor(
  entity: OfficeEntity,
  idx: number
): { col: number; row: number } {
  if (entity.kind === "employee") {
    if (entity.status === "fired") return EXIT_DOOR;
    if (entity.status === "pending")
      return COURT_TILES[idx % COURT_TILES.length];
    return EMPLOYEE_DESKS[idx % EMPLOYEE_DESKS.length];
  }
  if (entity.status === "fired") return EXIT_DOOR;
  return WORKER_DESKS[idx % WORKER_DESKS.length];
}

function tintFor(entity: OfficeEntity): Character["tint"] {
  if (entity.status === "fired") return "fired";
  if (entity.status === "pending") return "court";
  return null;
}

// ── Floor plan ───────────────────────────────────────────────────
type FloorKind = "wood" | "tile" | "carpet" | "wall";

function floorAt(col: number, row: number): FloorKind {
  if (col >= WORK_ROOM.c0 && col < WORK_ROOM.c1 && row >= WORK_ROOM.r0 && row < WORK_ROOM.r1)
    return "wood";
  if (col >= KITCHEN.c0 && col < KITCHEN.c1 && row >= KITCHEN.r0 && row < KITCHEN.r1)
    return "tile";
  if (col >= MEETING.c0 && col < MEETING.c1 && row >= MEETING.r0 && row < MEETING.r1)
    return "carpet";
  return "wall";
}

// ── Furniture ────────────────────────────────────────────────────

interface FurnitureInstance {
  asset: string;
  col: number;
  row: number;
  anchorY?: number;
}

const FURNITURE: FurnitureInstance[] = [
  // Bookshelves along work-room top wall
  { asset: "DOUBLE_BOOKSHELF", col: 1, row: 1 },
  { asset: "DOUBLE_BOOKSHELF", col: 4, row: 1 },
  { asset: "BOOKSHELF", col: 8, row: 2 },
  { asset: "BOOKSHELF", col: 11, row: 2 },
  // Desks (3 wide × 2 tall) — character sits at row+1
  { asset: "DESK_FRONT", col: 3, row: 7 },
  { asset: "DESK_FRONT", col: 7, row: 7 },
  { asset: "DESK_FRONT", col: 3, row: 12 },
  { asset: "DESK_FRONT", col: 7, row: 12 },
  // PCs on top of desks (centered on middle desk tile)
  { asset: "PC_FRONT_ON_1", col: 4, row: 6 },
  { asset: "PC_FRONT_ON_1", col: 8, row: 6 },
  { asset: "PC_FRONT_ON_1", col: 4, row: 11 },
  { asset: "PC_FRONT_ON_1", col: 8, row: 11 },
  // Plants in the work room — corners only so they don't block desks.
  { asset: "LARGE_PLANT", col: 1, row: 16 },
  { asset: "PLANT", col: 12, row: 1 },
  { asset: "PLANT", col: 1, row: 8 },
  // Worker zone gets WOODEN_CHAIRs facing up; characters sit on them.
  { asset: "WOODEN_CHAIR_BACK", col: 11, row: 8 },
  { asset: "WOODEN_CHAIR_BACK", col: 12, row: 8 },
  { asset: "WOODEN_CHAIR_BACK", col: 11, row: 13 },
  { asset: "WOODEN_CHAIR_BACK", col: 12, row: 13 },
  // Kitchen
  { asset: "COFFEE", col: 17, row: 1 },
  { asset: "COFFEE", col: 19, row: 1 },
  { asset: "BIN", col: 22, row: 2 },
  { asset: "CLOCK", col: 24, row: 1 },
  { asset: "PLANT", col: 27, row: 2 },
  // Meeting room
  { asset: "COFFEE_TABLE", col: 21, row: 13 },
  { asset: "SOFA_FRONT", col: 21, row: 11 },
  { asset: "SOFA_FRONT", col: 24, row: 11 },
  { asset: "CUSHIONED_CHAIR_FRONT", col: 21, row: 15 },
  { asset: "CUSHIONED_CHAIR_FRONT", col: 24, row: 15 },
  { asset: "SMALL_PAINTING", col: 22, row: 8 },
  { asset: "PLANT", col: 17, row: 11 },
  { asset: "PLANT", col: 27, row: 11 },
  { asset: "CACTUS", col: 16, row: 16 },
];

const FURN_SIZE: Record<string, { tw: number; th: number; pw: number; ph: number }> = {
  DESK_FRONT: { tw: 3, th: 2, pw: 48, ph: 32 },
  DESK_SIDE: { tw: 1, th: 4, pw: 16, ph: 64 },
  PC_FRONT_ON_1: { tw: 1, th: 1, pw: 16, ph: 32 },
  WOODEN_CHAIR_BACK: { tw: 1, th: 1, pw: 16, ph: 32 },
  BOOKSHELF: { tw: 2, th: 1, pw: 32, ph: 16 },
  DOUBLE_BOOKSHELF: { tw: 2, th: 1, pw: 32, ph: 32 },
  CLOCK: { tw: 1, th: 1, pw: 16, ph: 32 },
  COFFEE: { tw: 1, th: 1, pw: 16, ph: 16 },
  COFFEE_TABLE: { tw: 2, th: 2, pw: 32, ph: 32 },
  CUSHIONED_CHAIR_FRONT: { tw: 1, th: 1, pw: 16, ph: 16 },
  PLANT: { tw: 1, th: 1, pw: 16, ph: 32 },
  LARGE_PLANT: { tw: 2, th: 2, pw: 32, ph: 48 },
  SOFA_FRONT: { tw: 2, th: 1, pw: 32, ph: 16 },
  BIN: { tw: 1, th: 1, pw: 16, ph: 16 },
  SMALL_PAINTING: { tw: 1, th: 1, pw: 16, ph: 32 },
  CACTUS: { tw: 1, th: 1, pw: 16, ph: 32 },
};

const FURN_PATH: Record<string, string> = {
  DESK_FRONT: "/assets/pixel/furniture/DESK/DESK_FRONT.png",
  DESK_SIDE: "/assets/pixel/furniture/DESK/DESK_SIDE.png",
  PC_FRONT_ON_1: "/assets/pixel/furniture/PC/PC_FRONT_ON_1.png",
  WOODEN_CHAIR_BACK: "/assets/pixel/furniture/WOODEN_CHAIR/WOODEN_CHAIR_BACK.png",
  BOOKSHELF: "/assets/pixel/furniture/BOOKSHELF/BOOKSHELF.png",
  DOUBLE_BOOKSHELF: "/assets/pixel/furniture/DOUBLE_BOOKSHELF/DOUBLE_BOOKSHELF.png",
  CLOCK: "/assets/pixel/furniture/CLOCK/CLOCK.png",
  COFFEE: "/assets/pixel/furniture/COFFEE/COFFEE.png",
  COFFEE_TABLE: "/assets/pixel/furniture/COFFEE_TABLE/COFFEE_TABLE.png",
  CUSHIONED_CHAIR_FRONT: "/assets/pixel/furniture/CUSHIONED_CHAIR/CUSHIONED_CHAIR_FRONT.png",
  PLANT: "/assets/pixel/furniture/PLANT/PLANT.png",
  LARGE_PLANT: "/assets/pixel/furniture/LARGE_PLANT/LARGE_PLANT.png",
  SOFA_FRONT: "/assets/pixel/furniture/SOFA/SOFA_FRONT.png",
  BIN: "/assets/pixel/furniture/BIN/BIN.png",
  SMALL_PAINTING: "/assets/pixel/furniture/SMALL_PAINTING/SMALL_PAINTING.png",
  CACTUS: "/assets/pixel/furniture/CACTUS/CACTUS.png",
};

const FLOOR_PATHS: Record<FloorKind, string | null> = {
  // floor_5 is the most uniform light tile — least texture, best
  // canvas for runtime tinting via `multiply`.
  wood: "/assets/pixel/floors/floor_5.png",
  tile: "/assets/pixel/floors/floor_4.png",
  carpet: "/assets/pixel/floors/floor_5.png",
  wall: null,
};

const WALL_FILL_COLOR = "#1a1f2e";
const VOID_BG = "#0a0a0c";

// ── Asset loader ─────────────────────────────────────────────────

interface Assets {
  charSheets: HTMLImageElement[];
  floors: Record<FloorKind, HTMLImageElement | null>;
  furniture: Record<string, HTMLImageElement>;
}

async function loadAssets(): Promise<Assets> {
  const load = (src: string): Promise<HTMLImageElement> =>
    new Promise((res, rej) => {
      const img = new Image();
      img.onload = () => res(img);
      img.onerror = () => rej(new Error(`failed to load ${src}`));
      img.src = src;
    });
  const charSheets = await Promise.all(
    Array.from({ length: CHAR_SHEET_COUNT }, (_, i) =>
      load(`/assets/pixel/characters/char_${i}.png`)
    )
  );
  const floorEntries: [FloorKind, HTMLImageElement | null][] = await Promise.all(
    (Object.keys(FLOOR_PATHS) as FloorKind[]).map(async (k) => {
      const p = FLOOR_PATHS[k];
      if (!p) return [k, null] as [FloorKind, null];
      return [k, await load(p)] as [FloorKind, HTMLImageElement];
    })
  );
  const floors = Object.fromEntries(floorEntries) as Record<
    FloorKind,
    HTMLImageElement | null
  >;
  const furnEntries = await Promise.all(
    Object.entries(FURN_PATH).map(
      async ([k, p]) => [k, await load(p)] as [string, HTMLImageElement]
    )
  );
  const furniture = Object.fromEntries(furnEntries);
  return { charSheets, floors, furniture };
}

// ── Component ────────────────────────────────────────────────────

export function PixelOffice({
  entities,
  onSelect,
}: {
  entities: OfficeEntity[];
  /** Fires when the user clicks on a character. */
  onSelect?: (id: string) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const charsRef = useRef<Map<string, Character>>(new Map());
  const assetsRef = useRef<Assets | null>(null);
  const lastTimeRef = useRef<number>(0);
  const rafRef = useRef<number | null>(null);
  const onSelectRef = useRef(onSelect);
  // Keep the ref in sync after every commit so the click handler in the
  // game-loop effect always calls the latest prop without re-binding.
  useEffect(() => {
    onSelectRef.current = onSelect;
  }, [onSelect]);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    loadAssets()
      .then((a) => {
        if (cancelled) return;
        assetsRef.current = a;
        setReady(true);
      })
      .catch((e) => setError(String(e)));
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const chars = charsRef.current;
    const seen = new Set<string>();

    // Desk slots only get assigned to entities that actually need a desk
    // (active or spared employees, active workers). Fired and pending
    // entities have their own destination, so they don't take a slot
    // and don't push the next desk-needing entity off the edge. Pending
    // employees get their own running index across the court tiles so
    // multiple pending people don't all stack on tile #0.
    const empIdx = new Map<string, number>();
    const wrkIdx = new Map<string, number>();
    const courtIdx = new Map<string, number>();
    let e = 0;
    let w = 0;
    let p = 0;
    for (const ent of entities) {
      if (ent.kind === "employee") {
        if (ent.status === "fired") continue;
        if (ent.status === "pending") {
          courtIdx.set(ent.id, p++);
          continue;
        }
        empIdx.set(ent.id, e++);
      } else {
        if (ent.status === "fired") continue;
        wrkIdx.set(ent.id, w++);
      }
    }

    for (const ent of entities) {
      seen.add(ent.id);
      const idx =
        ent.kind === "employee"
          ? ent.status === "pending"
            ? (courtIdx.get(ent.id) ?? 0)
            : (empIdx.get(ent.id) ?? 0)
          : (wrkIdx.get(ent.id) ?? 0);
      const target = targetFor(ent, idx);
      const existing = chars.get(ent.id);
      if (!existing) {
        chars.set(ent.id, {
          id: ent.id,
          name: ent.name,
          paletteIdx: ent.paletteIdx % CHAR_SHEET_COUNT,
          x: EXIT_DOOR.col,
          y: EXIT_DOOR.row,
          targetCol: target.col,
          targetRow: target.row,
          dir: "down",
          anim: "walk",
          frame: 0,
          frameTimer: 0,
          tint: tintFor(ent),
        });
      } else {
        existing.targetCol = target.col;
        existing.targetRow = target.row;
        existing.tint = tintFor(ent);
        existing.paletteIdx = ent.paletteIdx % CHAR_SHEET_COUNT;
      }
    }
    for (const id of [...chars.keys()]) {
      if (!seen.has(id)) chars.delete(id);
    }
  }, [entities]);

  const floorPlan = useMemo(() => {
    const out: FloorKind[][] = [];
    for (let r = 0; r < ROWS; r++) {
      const row: FloorKind[] = [];
      for (let c = 0; c < COLS; c++) row.push(floorAt(c, r));
      out.push(row);
    }
    return out;
  }, []);

  useEffect(() => {
    if (!ready) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.imageSmoothingEnabled = false;

    // Hit-test on click. Map screen click coords back into canvas
    // pixel space (accounting for CSS scaling, e.g. fullscreen) and
    // pick the topmost character whose 16×32 sprite bbox covers the
    // click point — "topmost" meaning largest anchor Y so we select the
    // character drawn last in the Z-sort.
    const onClick = (e: MouseEvent) => {
      const cb = onSelectRef.current;
      if (!cb) return;
      const rect = canvas.getBoundingClientRect();
      const cx = ((e.clientX - rect.left) * CANVAS_W) / rect.width;
      const cy = ((e.clientY - rect.top) * CANVAS_H) / rect.height;
      const drawW = CHAR_FRAME_W * ZOOM;
      const drawH = CHAR_FRAME_H * ZOOM;
      let hitId: string | null = null;
      let bestY = -Infinity;
      for (const ch of charsRef.current.values()) {
        const wx = ch.x * TILE * ZOOM + (TILE * ZOOM) / 2;
        const wy = (ch.y + 1) * TILE * ZOOM;
        if (
          cx >= wx - drawW / 2 &&
          cx <= wx + drawW / 2 &&
          cy >= wy - drawH &&
          cy <= wy
        ) {
          if (ch.y > bestY) {
            bestY = ch.y;
            hitId = ch.id;
          }
        }
      }
      if (hitId) cb(hitId);
    };
    canvas.addEventListener("click", onClick);
    canvas.style.cursor = "pointer";

    const tick = (now: number) => {
      const last = lastTimeRef.current || now;
      const dt = Math.min(0.05, (now - last) / 1000);
      lastTimeRef.current = now;
      step(dt);
      draw(ctx);
      rafRef.current = requestAnimationFrame(tick);
    };

    const step = (dt: number) => {
      for (const ch of charsRef.current.values()) {
        const dx = ch.targetCol - ch.x;
        const dy = ch.targetRow - ch.y;
        const dist = Math.hypot(dx, dy);
        const isMoving = dist > 0.05;

        if (isMoving) {
          const move = WALK_SPEED_TILES_PER_SEC * dt;
          if (Math.abs(dx) > Math.abs(dy)) {
            ch.x += Math.sign(dx) * Math.min(Math.abs(dx), move);
            ch.dir = dx > 0 ? "right" : "left";
          } else {
            ch.y += Math.sign(dy) * Math.min(Math.abs(dy), move);
            ch.dir = dy > 0 ? "down" : "up";
          }
          ch.anim = "walk";
          ch.frameTimer += dt;
          if (ch.frameTimer >= WALK_FRAME_DURATION) {
            ch.frameTimer -= WALK_FRAME_DURATION;
            ch.frame = (ch.frame + 1) % 4;
          }
        } else {
          ch.x = ch.targetCol;
          ch.y = ch.targetRow;
          const wantType =
            ch.tint === null && (ch.id.startsWith("w") || ch.id.startsWith("worker"));
          ch.anim = wantType ? "type" : "idle";
          ch.frameTimer += dt;
          if (ch.anim === "type") {
            if (ch.frameTimer >= TYPE_FRAME_DURATION) {
              ch.frameTimer -= TYPE_FRAME_DURATION;
              ch.frame = (ch.frame + 1) % 2;
            }
          } else {
            ch.frame = 1;
          }
        }
      }
    };

    const draw = (c: CanvasRenderingContext2D) => {
      // 1. Void background.
      c.fillStyle = VOID_BG;
      c.fillRect(0, 0, CANVAS_W, CANVAS_H);

      // 2. Floor tiles per cell.
      const floors = assetsRef.current!.floors;
      for (let r = 0; r < ROWS; r++) {
        for (let col = 0; col < COLS; col++) {
          const kind = floorPlan[r][col];
          const img = floors[kind];
          if (!img) continue;
          c.drawImage(
            img,
            0,
            0,
            TILE,
            TILE,
            col * TILE * ZOOM,
            r * TILE * ZOOM,
            TILE * ZOOM,
            TILE * ZOOM
          );
        }
      }

      // 2b. Per-room multiply tint so a single grayscale tile atlas
      //     yields warm wood, cool carpet, and pale kitchen.
      c.save();
      c.globalCompositeOperation = "multiply";
      const room = (rect: { c0: number; r0: number; c1: number; r1: number }, color: string) => {
        c.fillStyle = color;
        c.fillRect(
          rect.c0 * TILE * ZOOM,
          rect.r0 * TILE * ZOOM,
          (rect.c1 - rect.c0) * TILE * ZOOM,
          (rect.r1 - rect.r0) * TILE * ZOOM
        );
      };
      const wood = FLOOR_TINTS.wood;
      const tile = FLOOR_TINTS.tile;
      const carpet = FLOOR_TINTS.carpet;
      if (wood) room(WORK_ROOM, wood);
      if (tile) room(KITCHEN, tile);
      if (carpet) room(MEETING, carpet);
      c.restore();

      // 3. Walls.
      c.fillStyle = WALL_FILL_COLOR;
      for (const w of WALL_FILLS) {
        c.fillRect(
          w.c * TILE * ZOOM,
          w.r * TILE * ZOOM,
          w.w * TILE * ZOOM,
          w.h * TILE * ZOOM
        );
      }
      c.fillStyle = "rgba(255, 220, 180, 0.06)";
      for (const d of DOOR_HIGHLIGHTS) {
        c.fillRect(
          d.c * TILE * ZOOM,
          d.r * TILE * ZOOM,
          d.w * TILE * ZOOM,
          d.h * TILE * ZOOM
        );
      }

      // 4. Court rug — solid orange, drawn over the carpet so it
      //    actually reads at a glance.
      c.fillStyle = "rgba(255,120,60,0.55)";
      for (const t of COURT_TILES) {
        c.fillRect(
          t.col * TILE * ZOOM,
          t.row * TILE * ZOOM,
          TILE * ZOOM,
          TILE * ZOOM
        );
      }

      // 5. Exit door mat — deep red.
      c.fillStyle = "rgba(180,40,30,0.85)";
      c.fillRect(
        EXIT_DOOR.col * TILE * ZOOM,
        EXIT_DOOR.row * TILE * ZOOM,
        TILE * ZOOM,
        TILE * ZOOM
      );
      // Door frame highlight.
      c.strokeStyle = "rgba(255,180,120,0.6)";
      c.lineWidth = 2;
      c.strokeRect(
        EXIT_DOOR.col * TILE * ZOOM,
        EXIT_DOOR.row * TILE * ZOOM,
        TILE * ZOOM,
        TILE * ZOOM
      );

      // 6. Furniture + characters merged, Z-sorted by anchor Y.
      type Drawable = { y: number; render: () => void };
      const drawables: Drawable[] = [];

      const furn = assetsRef.current!.furniture;
      for (const f of FURNITURE) {
        const sz = FURN_SIZE[f.asset];
        if (!sz) continue;
        const img = furn[f.asset];
        if (!img) continue;
        const drawW = sz.pw * ZOOM;
        const drawH = sz.ph * ZOOM;
        const dx = f.col * TILE * ZOOM;
        const dy = (f.row + sz.th) * TILE * ZOOM - drawH;
        const anchorY = (f.anchorY ?? f.row + sz.th) - 0.01;
        drawables.push({
          y: anchorY,
          render: () => {
            c.drawImage(img, 0, 0, sz.pw, sz.ph, dx, dy, drawW, drawH);
          },
        });
      }

      const sheets = assetsRef.current!.charSheets;
      for (const ch of charsRef.current.values()) {
        const sheet = sheets[ch.paletteIdx];
        const dirRow = ch.dir === "down" ? 0 : ch.dir === "up" ? 1 : 2;
        let frameCol: number;
        if (ch.anim === "walk") {
          frameCol = ch.frame === 0 ? 0 : ch.frame === 2 ? 2 : 1;
        } else if (ch.anim === "type") {
          frameCol = 3 + (ch.frame % 2);
        } else {
          frameCol = 1;
        }
        const sx = frameCol * CHAR_FRAME_W;
        const sy = dirRow * CHAR_FRAME_H;

        const worldX = ch.x * TILE * ZOOM + (TILE * ZOOM) / 2;
        const worldY = (ch.y + 1) * TILE * ZOOM;
        const drawW = CHAR_FRAME_W * ZOOM;
        const drawH = CHAR_FRAME_H * ZOOM;
        const dx = worldX - drawW / 2;
        const dy = worldY - drawH;
        const anchorY = ch.y + 1;
        const tint = ch.tint;
        const dir = ch.dir;
        const name = ch.name;

        drawables.push({
          y: anchorY,
          render: () => {
            c.save();
            if (dir === "left") {
              c.translate(dx + drawW, dy);
              c.scale(-1, 1);
              c.drawImage(sheet, sx, sy, CHAR_FRAME_W, CHAR_FRAME_H, 0, 0, drawW, drawH);
            } else {
              c.drawImage(sheet, sx, sy, CHAR_FRAME_W, CHAR_FRAME_H, dx, dy, drawW, drawH);
            }
            if (tint === "fired") {
              c.globalCompositeOperation = "source-atop";
              c.fillStyle = "rgba(40,40,40,0.55)";
              if (dir === "left") c.fillRect(0, 0, drawW, drawH);
              else c.fillRect(dx, dy, drawW, drawH);
            } else if (tint === "court") {
              c.globalCompositeOperation = "source-atop";
              c.fillStyle = "rgba(255,90,30,0.35)";
              if (dir === "left") c.fillRect(0, 0, drawW, drawH);
              else c.fillRect(dx, dy, drawW, drawH);
            }
            c.restore();

            c.fillStyle = "rgba(0,0,0,0.7)";
            c.fillRect(dx + 2, dy - 14, drawW - 4, 12);
            c.fillStyle = "#f4f4f7";
            c.font = "10px monospace";
            c.textBaseline = "top";
            c.textAlign = "center";
            c.fillText(name, worldX, dy - 12);
          },
        });
      }

      drawables.sort((a, b) => a.y - b.y);
      for (const d of drawables) d.render();
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      canvas.removeEventListener("click", onClick);
    };
  }, [ready, floorPlan]);

  if (error) {
    return (
      <div className="border border-[var(--accent)]/60 bg-[var(--accent-dim)]/20 p-4 text-[10px] font-mono text-[var(--accent)]">
        Pixel office failed to load assets: {error}
      </div>
    );
  }

  return (
    <PixelOfficeFrame canvasRef={canvasRef} ready={ready} />
  );
}

/**
 * Frame wrapper that owns the fullscreen toggle. The canvas renders at
 * a fixed CANVAS_W × CANVAS_H bitmap (preserves pixel-perfect art); CSS
 * scales it up when the user enters fullscreen, with `aspect-ratio`
 * locked to the canvas dims so the office never stretches.
 */
function PixelOfficeFrame({
  canvasRef,
  ready,
}: {
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  ready: boolean;
}) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [fullscreen, setFullscreen] = useState(false);

  useEffect(() => {
    const onChange = () => {
      setFullscreen(document.fullscreenElement === wrapRef.current);
    };
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  const toggle = async () => {
    const el = wrapRef.current;
    if (!el) return;
    try {
      if (document.fullscreenElement === el) {
        await document.exitFullscreen();
      } else {
        await el.requestFullscreen();
      }
    } catch {
      // Fullscreen API not available or blocked — silently no-op.
    }
  };

  // In fullscreen, scale canvas via CSS so it fills the viewport while
  // keeping the 30:18 aspect.
  const canvasStyle: React.CSSProperties = fullscreen
    ? {
        width: "min(100vw, calc(100vh * 30 / 18))",
        height: "min(100vh, calc(100vw * 18 / 30))",
        imageRendering: "pixelated",
        display: "block",
      }
    : {
        width: CANVAS_W,
        height: CANVAS_H,
        imageRendering: "pixelated",
        display: "block",
      };

  const wrapClass = fullscreen
    ? "bg-[#0a0a0c] w-screen h-screen flex items-center justify-center relative"
    : "border border-[var(--border)] bg-[#0a0a0c] p-3 inline-block relative";

  return (
    <div ref={wrapRef} className={wrapClass}>
      <canvas
        ref={canvasRef}
        width={CANVAS_W}
        height={CANVAS_H}
        style={canvasStyle}
        aria-label="Pixel office: live OpenFire agent state"
      />
      <button
        type="button"
        onClick={toggle}
        className="absolute top-2 right-2 z-10 px-2.5 py-1 text-[10px] font-mono tracking-[0.18em] uppercase border border-[var(--border-raised)] bg-[var(--surface)]/85 text-[var(--text-muted)] hover:text-[var(--text)] hover:border-[var(--accent)] hover:bg-[var(--surface-raised)] transition-colors"
      >
        {fullscreen ? "Exit Fullscreen [Esc]" : "Fullscreen ⛶"}
      </button>
      {!ready && !fullscreen ? (
        <div className="text-[10px] font-mono text-[var(--text-dim)] mt-2 tracking-[0.2em] uppercase">
          Loading sprites…
        </div>
      ) : null}
    </div>
  );
}
