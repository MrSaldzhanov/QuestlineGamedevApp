#!/usr/bin/env node
// Валидатор plan.json (questline.plan/1). Запуск: node validate.mjs path/to/plan.json
import { readFileSync } from "node:fs";

const file = process.argv[2];
if (!file) {
  console.error("usage: node validate.mjs path/to/plan.json");
  process.exit(2);
}

let plan;
try {
  plan = JSON.parse(readFileSync(file, "utf8").replace(/^﻿/, ""));
} catch (e) {
  console.error(`✗ не читается как JSON: ${e.message}`);
  process.exit(1);
}

const errors = [];
const warnings = [];
const err = (m) => errors.push(m);
const warn = (m) => warnings.push(m);

const KINDS = new Set(["agent", "review", "play", "me"]);
const WEEK_TYPES = new Set(["work", "polish", "buffer"]);
const ID_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

if (plan.schema !== "questline.plan/1") err(`schema должен быть "questline.plan/1", а не ${JSON.stringify(plan.schema)}`);
if (!Number.isInteger(plan.revision) || plan.revision < 1) err("revision должен быть целым ≥ 1");
if (plan.changes != null) {
  const ch = plan.changes;
  if (typeof ch !== "object" || Array.isArray(ch)) err("changes — объект { revision, summary, items }");
  else {
    if (ch.revision != null && ch.revision !== plan.revision) warn(`changes.revision ${ch.revision} ≠ revision ${plan.revision} — приложение не покажет это пояснение`);
    if (ch.summary != null && typeof ch.summary !== "string") err("changes.summary — строка");
    if (ch.items != null && (!Array.isArray(ch.items) || ch.items.some((x) => typeof x !== "string"))) err("changes.items — массив строк");
  }
} else if (plan.revision > 1) warn("нет changes — напиши, что и почему поменялось в этой ревизии (приложение покажет это над списком изменений)");

const p = plan.project ?? {};
if (!p.id || !ID_RE.test(p.id)) err("project.id обязателен, kebab-case");
if (!p.name) err("project.name обязателен");
if (!DATE_RE.test(p.startDate ?? "")) err("project.startDate должен быть YYYY-MM-DD");
else if (new Date(p.startDate + "T00:00:00Z").getUTCDay() !== 1) err(`project.startDate ${p.startDate} — не понедельник`);
if (!(p.weeklyCapacityHours > 0)) err("project.weeklyCapacityHours должен быть > 0");
if (p.accent && !COLOR_RE.test(p.accent)) err("project.accent должен быть #RRGGBB");

// Тема: фон рисуется под светлым текстом, поэтому цвета должны быть тёмными
const luminance = (hex) => {
  const n = parseInt(hex.slice(1), 16);
  const lin = (c) => ((c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
};
const th = p.theme;
if (th) {
  const PARTICLES = new Set(["stars", "snow", "fireflies", "bubbles", "petals", "none"]);
  if (th.background != null) {
    if (!Array.isArray(th.background) || th.background.length < 2 || th.background.length > 4) err("theme.background — массив из 2–4 цветов");
    else
      for (const c of th.background) {
        if (!COLOR_RE.test(c)) err(`theme.background: ${c} не #RRGGBB`);
        else if (luminance(c) > 0.12) warn(`theme.background: ${c} слишком светлый — белый текст будет плохо читаться`);
      }
  }
  for (const k of ["glow", "particleColor"]) if (th[k] && !COLOR_RE.test(th[k])) err(`theme.${k} должен быть #RRGGBB`);
  if (th.particles && !PARTICLES.has(th.particles)) err(`theme.particles: ${th.particles} не из ${[...PARTICLES].join("|")}`);
  if (th.image != null && !/^[\w./-]+\.(jpe?g|png|webp)$/i.test(th.image)) err("theme.image — путь к jpg/png/webp относительно папки плана");
  if (th.imageOpacity != null && !(th.imageOpacity >= 0 && th.imageOpacity <= 1)) err("theme.imageOpacity вне 0..1");
}

// Блоки
const blocks = new Map();
for (const b of plan.blocks ?? []) {
  if (!ID_RE.test(b.id ?? "")) err(`блок ${JSON.stringify(b.id)}: id не kebab-case`);
  if (blocks.has(b.id)) err(`блок ${b.id}: дубль id`);
  blocks.set(b.id, b);
  if (b.color && !COLOR_RE.test(b.color)) err(`блок ${b.id}: color должен быть #RRGGBB`);
  if (b.baselinePercent != null && !(b.baselinePercent >= 0 && b.baselinePercent <= 100)) err(`блок ${b.id}: baselinePercent вне 0..100`);
}
if (blocks.size === 0) err("нет ни одного блока");

// Недели
const weeks = new Map();
for (const w of plan.weeks ?? []) {
  if (!Number.isInteger(w.index) || w.index < 1) err(`неделя ${JSON.stringify(w.index)}: index должен быть целым ≥ 1`);
  if (weeks.has(w.index)) err(`неделя ${w.index}: дубль`);
  weeks.set(w.index, w);
  if (!WEEK_TYPES.has(w.type)) err(`неделя ${w.index}: type ${JSON.stringify(w.type)} не из work|polish|buffer`);
}
const maxWeek = Math.max(0, ...weeks.keys());
for (let i = 1; i <= maxWeek; i++) if (!weeks.has(i)) err(`пропущена неделя ${i}`);

// Вехи
const msIds = new Set();
for (const m of plan.milestones ?? []) {
  if (!ID_RE.test(m.id ?? "")) err(`веха ${JSON.stringify(m.id)}: id не kebab-case`);
  if (msIds.has(m.id)) err(`веха ${m.id}: дубль id`);
  msIds.add(m.id);
  if (!weeks.has(m.week)) err(`веха ${m.id}: неделя ${m.week} не существует`);
}

// Задачи
const tasks = new Map();
for (const t of plan.tasks ?? []) {
  const where = `задача ${t.id}`;
  if (!ID_RE.test(t.id ?? "")) err(`задача ${JSON.stringify(t.id)}: id не kebab-case`);
  if (tasks.has(t.id)) err(`${where}: дубль id`);
  tasks.set(t.id, t);
  if (!t.title) err(`${where}: нет title`);
  if (!blocks.has(t.block)) err(`${where}: блок ${JSON.stringify(t.block)} не существует`);
  if (!KINDS.has(t.kind)) err(`${where}: kind ${JSON.stringify(t.kind)} не из agent|review|play|me`);
  if (!(t.estimateHours > 0)) err(`${where}: estimateHours должен быть > 0`);
  if (t.week != null && !weeks.has(t.week)) err(`${where}: неделя ${t.week} не существует`);
  if (![1, 2, 3].includes(t.priority)) err(`${where}: priority должен быть 1|2|3`);
  if (!Array.isArray(t.deps)) err(`${where}: deps должен быть массивом`);
  if (t.kind === "agent" && !t.prompt) warn(`${where}: agent-задача без prompt`);
  if ((t.kind === "play" || t.kind === "review") && !(t.checklist?.length)) warn(`${where}: ${t.kind}-задача без checklist`);
  if (t.tags != null && (!Array.isArray(t.tags) || t.tags.some(g => typeof g !== "string" || !ID_RE.test(g))))
    err(`${where}: tags — массив kebab-case строк`);
  if (t.decision != null && (typeof t.decision !== "string" || !t.decision.trim())) err(`${where}: decision — непустой вопрос`);
}

// Зависимости: существуют, без циклов, не позже по неделям
for (const t of tasks.values()) {
  for (const d of t.deps ?? []) {
    const dep = tasks.get(d);
    if (!dep) { err(`задача ${t.id}: зависимость ${d} не существует`); continue; }
    if (d === t.id) err(`задача ${t.id}: зависит от самой себя`);
    if (t.week != null && dep.week == null) err(`задача ${t.id} (неделя ${t.week}) зависит от ${d} из бэклога`);
    if (t.week != null && dep.week != null && dep.week > t.week)
      err(`задача ${t.id} (неделя ${t.week}) зависит от ${d}, которая позже — неделя ${dep.week}`);
  }
}
const state = new Map(); // 1 = в стеке, 2 = готово
const visit = (id, path) => {
  if (state.get(id) === 2) return;
  if (state.get(id) === 1) { err(`цикл зависимостей: ${[...path, id].join(" → ")}`); return; }
  state.set(id, 1);
  for (const d of tasks.get(id)?.deps ?? []) if (tasks.has(d)) visit(d, [...path, id]);
  state.set(id, 2);
};
for (const id of tasks.keys()) visit(id, []);

// Загрузка недель
const load = new Map();
for (const t of tasks.values()) if (t.week != null) load.set(t.week, (load.get(t.week) ?? 0) + t.estimateHours);
for (const w of weeks.values()) {
  const cap = w.capacityHours ?? p.weeklyCapacityHours;
  const h = load.get(w.index) ?? 0;
  if (h > cap * 1.1) err(`неделя ${w.index}: ${h.toFixed(1)} ч при ёмкости ${cap} (предел ${(cap * 1.1).toFixed(1)})`);
  if (w.type === "work" && h < cap * 0.5) warn(`неделя ${w.index}: загружена только на ${h.toFixed(1)} из ${cap} ч`);
  if (w.type === "polish") {
    for (const t of tasks.values()) {
      if (t.week !== w.index) continue;
      const ok = t.kind === "play" || t.kind === "review" || (t.tags ?? []).includes("polish");
      if (!ok) err(`задача ${t.id} в polish-неделе ${w.index}: нужна kind play/review или тег "polish"`);
    }
  }
}

// Итог
const scheduled = [...tasks.values()].filter((t) => t.week != null);
const total = scheduled.reduce((s, t) => s + t.estimateHours, 0);
const backlog = tasks.size - scheduled.length;
const end = new Date(new Date(p.startDate + "T00:00:00Z").getTime() + (maxWeek * 7 - 1) * 864e5);

for (const w of warnings) console.log(`⚠ ${w}`);
if (errors.length) {
  for (const e of errors) console.log(`✗ ${e}`);
  console.log(`\n✗ ${errors.length} ошибок, ${warnings.length} предупреждений`);
  process.exit(1);
}
console.log(
  `✓ ${p.name}: ${maxWeek} недель, ${tasks.size} задач (${backlog} в бэклоге), ${total.toFixed(0)} ч в плане, ` +
  `последняя неделя заканчивается ${end.toISOString().slice(0, 10)}` +
  (warnings.length ? `, ${warnings.length} предупреждений` : "")
);
