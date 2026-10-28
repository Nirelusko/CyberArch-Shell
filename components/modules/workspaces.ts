// Workspace pill row for the restored G/odd-even layout.
//
// Each monitor only shows its own slots:
//   ROG (left, 165Hz):  G | 1 3 5 7 9
//   AOC (right, 144Hz): 2 4 6 8 10
// G shows when active/occupied. Clicking a pill calls scripts/ws go <target>,
// which focuses the workspace and asks the shell to play the glitch transition.
import { Box, DrawingArea, EventBox } from "./widget.ts"
import { execAsync, interval } from "astal"
import { CYBER_DIR, scaleOf } from "../../env.ts"
import { RGB, f, NEON, onColorChange } from "./colors.ts"
import { TITLE } from "./fonts.ts"
import GLib from "gi://GLib"
import Gdk from "gi://Gdk?version=3.0"
import { makePlane } from "./proj.ts"
import type { Plane } from "./proj.ts"

type Slot = { key: string; label: string; target: string }

const GAMING: Slot = { key: "gaming", label: "G", target: "Gaming" }
const ODDS: Slot[] = [1, 3, 5, 7, 9].map(n => ({ key: String(n), label: String(n), target: String(n) }))
const EVENS: Slot[] = [2, 4, 6, 8, 10].map(n => ({ key: String(n), label: String(n), target: String(n) }))

const SLOT_W = 34, SLOT_H = 26, GAP = 6, GROUP_GAP = 14, PAD = 5

const rowWidth = (count: number, withGaming: boolean) => {
    if (count <= 0) return PAD * 2
    let w = PAD * 2 + count * SLOT_W + (count - 1) * GAP
    if (withGaming) w += GROUP_GAP - GAP
    return w
}

let occupied = new Set<string>()
let activeByGeom = new Map<string, string>()
let focusedKey = "1"
const listeners = new Set<() => void>()
let timer: any = null
let refreshing = false

const geomKey = (g: any) => `${g.x},${g.y},${g.width},${g.height}`
const keyOf = (id: any, name: any): string => {
    const n = String(name ?? "").trim()
    if (n === "Gaming" || n === "name:Gaming") return "gaming"
    if (typeof id === "number" && id > 0) return String(id)
    return n
}

const refresh = async () => {
    if (refreshing) return
    refreshing = true
    try {
        const [wsRaw, monRaw] = await Promise.all([
            execAsync(["hyprctl", "workspaces", "-j"]),
            execAsync(["hyprctl", "monitors", "-j"]),
        ])
        const wss = JSON.parse(wsRaw) as any[]
        const mons = JSON.parse(monRaw) as any[]
        const occ = new Set<string>()
        for (const w of wss) if ((w.windows ?? 0) > 0) occ.add(keyOf(w.id, w.name))
        const act = new Map<string, string>()
        for (const m of mons) {
            const k = `${m.x},${m.y},${m.width},${m.height}`
            const key = keyOf(m.activeWorkspace?.id, m.activeWorkspace?.name)
            act.set(k, key)
            if (m.focused) focusedKey = key
        }
        occupied = occ
        activeByGeom = act
        for (const cb of listeners) { try { cb() } catch (e) { print("[workspaces] notify:", e) } }
    } catch (e) { }
    finally { refreshing = false }
}

const attach = (cb: () => void) => {
    listeners.add(cb)
    if (!timer) { refresh(); timer = interval(150, refresh) }
    return () => {
        listeners.delete(cb)
        if (listeners.size === 0 && timer) { timer.cancel(); timer = null }
    }
}

const drawPill = (ctx: any, x: number, y: number, w: number, h: number, label: string, active: boolean, occ: boolean, hov: boolean) => {
    const col: RGB = active ? NEON.red : occ ? NEON.badge : NEON.dim
    const [r, g, b] = f(col)
    const alpha = active ? 1 : occ ? 0.9 : 0.42
    const c = 4

    const path = () => {
        ctx.newPath()
        ctx.moveTo(x, y)
        ctx.lineTo(x + w - c, y)
        ctx.lineTo(x + w, y + c)
        ctx.lineTo(x + w, y + h)
        ctx.lineTo(x + c, y + h)
        ctx.lineTo(x, y + h - c)
        ctx.closePath()
    }

    if (active || occ || hov) {
        ctx.setOperator(12)
        const k = active ? 1.25 : hov ? 1.1 : 0.85
        for (const [lw, a] of [[6, 0.05], [3.5, 0.09], [1.5, 0.18]] as const) {
            path()
            ctx.setSourceRGBA(r, g, b, a * k)
            ctx.setLineWidth(lw)
            ctx.stroke()
        }
        ctx.setOperator(2)
    }

    path()
    ctx.setSourceRGBA(r, g, b, active ? 0.20 : occ ? 0.12 : hov ? 0.08 : 0.05)
    ctx.fill()

    path()
    ctx.setSourceRGBA(r, g, b, hov && !active ? Math.min(1, alpha + 0.1) : alpha)
    ctx.setLineWidth(active ? 1.7 : 1.1)
    ctx.stroke()

    ctx.selectFontFace(TITLE, 0, 1)
    const fs = label.length > 1 ? 10 : 12
    ctx.setFontSize(fs)
    const te = ctx.textExtents(label)
    ctx.setSourceRGBA(active ? 1 : r, active ? 1 : g, active ? 1 : b, active ? 1 : occ ? 0.95 : 0.55)
    ctx.moveTo(x + (w - te.width) / 2 - te.xbearing, y + h / 2 + te.height / 2 - 1)
    ctx.showText(label)
}

const monitorIsAoc = (mon?: any) => {
    try {
        const id = `${mon?.get_manufacturer?.() ?? ""} ${mon?.get_model?.() ?? ""}`.toLowerCase()
        if (id.includes("aoc") || id.includes("q27g2")) return true
        if (id.includes("rog") || id.includes("pg279") || id.includes("asus")) return false
    } catch {}
    try { const g = mon?.get_geometry?.(); if (g) return g.x > 0 } catch {}
    return false
}

export const Workspaces = (mon?: any) => {
    let geometry: any = null
    try { geometry = mon?.get_geometry?.() } catch {}
    const key = geometry ? geomKey(geometry) : ""
    const base = monitorIsAoc(mon) ? EVENS : [GAMING, ...ODDS]
    const W = rowWidth(base.length, base[0] === GAMING)
    const H = SLOT_H + PAD * 2
    // Keep the full logical width so projected pills aren't clipped
    const S = scaleOf(mon, "workspaces", { width: W + 60, height: H + 20 })
    const area = DrawingArea({})
    area.set_size_request(Math.round((W + 40) * S), Math.round((H + 16) * S))

    // Keep flat like the rest of the HUD for now
    const plane = makePlane({ w: W + 40, h: H + 16, yaw: monitorIsAoc(mon) ? 10 : -10, pitch: -2, roll: 0, focal: 2200, dist: 2300, pad: 16 })

    let rects: Array<{ x: number; y: number; w: number; h: number; slot: Slot }> = []
    let hover: string | null = null

    area.connect("draw", (_w: any, ctx: any) => {
        ctx.scale(S, S)
        const active = activeByGeom.get(key) ?? focusedKey
        const slots = base.filter(s => s.key !== "gaming" || s.key === active || occupied.has("gaming"))
        const width = rowWidth(slots.length, slots[0]?.key === "gaming")
        const ox = 20, oy = 2

        const drawAngled = (x: number, y: number, w: number, h: number) => {
            const cut = Math.min(6, w / 4, h / 4)
            const pts: [number, number][] = [[x, y], [x + w - cut, y], [x + w, y + cut], [x + w, y + h], [x + cut, y + h], [x, y + h - cut]]
            ctx.newPath()
            pts.forEach(([u, v], i) => { const [px, py] = plane.project(ox + u, oy + v); i ? ctx.lineTo(px, py) : ctx.moveTo(px, py) })
            ctx.closePath()
        }

        drawAngled(2, 0, width - 4, H)
        ctx.setSourceRGBA(4 / 255, 8 / 255, 12 / 255, 0.55)
        ctx.fill()
        const [br, bg, bb] = f(NEON.red)
        drawAngled(2, 0, width - 4, H)
        ctx.setSourceRGBA(br, bg, bb, 0.14)
        ctx.setLineWidth(1)
        ctx.stroke()

        let x = ox + PAD
        rects = []
        slots.forEach((slot, i) => {
            if (i > 0) x += slots[i - 1].key === "gaming" ? GROUP_GAP : GAP
            const on = slot.key === active
            const col: RGB = on ? NEON.red : occupied.has(slot.key) ? NEON.badge : NEON.dim
            const [r, g, b] = f(col)
            const alpha = on ? 1 : occupied.has(slot.key) ? 0.9 : 0.42

            const ppath = () => {
                const cut = Math.min(4, SLOT_W / 3, SLOT_H / 3)
                const pts: [number, number][] = [[x, oy + PAD], [x + SLOT_W - cut, oy + PAD], [x + SLOT_W, oy + PAD + cut], [x + SLOT_W, oy + PAD + SLOT_H], [x + cut, oy + PAD + SLOT_H], [x, oy + PAD + SLOT_H - cut]]
                ctx.newPath()
                pts.forEach(([u, v], j) => { const [px, py] = plane.project(u, v); j ? ctx.lineTo(px, py) : ctx.moveTo(px, py) })
                ctx.closePath()
            }

            if (on || occupied.has(slot.key) || hover === slot.key) {
                ctx.setOperator(12)
                const k = on ? 1.25 : hover === slot.key ? 1.1 : 0.85
                for (const [lw, a] of [[6, 0.05], [3.5, 0.09], [1.5, 0.18]] as const) {
                    ppath()
                    ctx.setSourceRGBA(r, g, b, a * k)
                    ctx.setLineWidth(lw)
                    ctx.stroke()
                }
                ctx.setOperator(2)
            }

            ppath()
            ctx.setSourceRGBA(r, g, b, on ? 0.20 : occupied.has(slot.key) ? 0.12 : hover === slot.key ? 0.08 : 0.05)
            ctx.fill()
            ppath()
            ctx.setSourceRGBA(r, g, b, hover === slot.key && !on ? Math.min(1, alpha + 0.1) : alpha)
            ctx.setLineWidth(on ? 1.7 : 1.1)
            ctx.stroke()

            const [cx, cy] = plane.project(x + SLOT_W / 2, oy + PAD + SLOT_H / 2)
            const ang = plane.angleAt(x + SLOT_W / 2, oy + PAD + SLOT_H / 2)
            const sc = plane.scaleAt(x + SLOT_W / 2, oy + PAD + SLOT_H / 2)
            ctx.save()
            ctx.translate(cx, cy)
            ctx.rotate(ang)
            ctx.scale(sc, sc)
            ctx.selectFontFace(TITLE, 0, 1)
            const fs = slot.label.length > 1 ? 10 : 12
            ctx.setFontSize(fs)
            const te = ctx.textExtents(slot.label)
            ctx.setSourceRGBA(on ? 1 : r, on ? 1 : g, on ? 1 : b, on ? 1 : occupied.has(slot.key) ? 0.95 : 0.55)
            ctx.moveTo(-te.width / 2 - te.xbearing, te.height / 2 - 1)
            ctx.showText(slot.label)
            ctx.restore()

            rects.push({ x: x - ox, y: PAD, w: SLOT_W, h: SLOT_H, slot })
            x += SLOT_W
        })
        return false
    })

    const evt = EventBox({ child: area })
    try { evt.add_events(Gdk.EventMask.POINTER_MOTION_MASK | Gdk.EventMask.BUTTON_PRESS_MASK | Gdk.EventMask.LEAVE_NOTIFY_MASK) } catch {}

    const hit = (e: any) => {
        const x = (e.x ?? 0) / S, y = (e.y ?? 0) / S
        return rects.find(r => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h)
    }

    evt.connect("motion-notify-event", (_w: any, e: any) => {
        const found = hit(e)
        const next = found ? found.slot.key : null
        if (next !== hover) { hover = next; area.queue_draw() }
        return false
    })
    evt.connect("leave-notify-event", () => { hover = null; area.queue_draw(); return false })
    evt.connect("button-press-event", (_w: any, e: any) => {
        if (e.button !== 1) return false
        const r = hit(e)
        if (!r) return false
        activeByGeom.set(key, r.slot.key)
        area.queue_draw()
        execAsync([`${CYBER_DIR}/scripts/ws`, "go", r.slot.target]).catch(print)
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => { refresh(); return GLib.SOURCE_REMOVE })
        return true
    })

    const detach = attach(() => area.queue_draw())
    const recolor = onColorChange(() => area.queue_draw())
    area.connect("destroy", () => { detach(); recolor() })

    return Box({ className: "workspaces", children: [evt] })
}
