// Pary.js — расписание БИАС-14 + замены + уведомления (Scriptable)
// Запускается из «Команд» по времени (19:35 и 06:30). Пересоздаёт уведомления на сегодня и завтра.

// ===== НАСТРОЙКИ =====
const TRAVEL_MIN = 60;      // дорога от двери до колледжа, мин
const BUFFER_MIN = 10;      // запас, мин
const MORNING_LEAD = 30;    // за сколько минут до выхода напомнить
const NEXT_LEAD = 15;       // за сколько минут до конца пары говорить про следующую
const EVENING_TIME = "19:40";
const MONDAY_ASSEMBLY = "08:00"; // «Разговоры о важном» (null — не учитывать)
const REPLACEMENTS_URL = "";     // позже: ссылка на JSON от парсера. Пусто = файл replacements.json в папке Scriptable

// Замены вручную (если нет файла replacements.json). Формат — как в replacements.example.json
const MANUAL_REPLACEMENTS = [];

const BELLS = { 1: ["08:30", "10:05"], 2: ["10:15", "11:50"], 3: ["12:30", "14:05"], 4: ["14:15", "15:50"] };

// Дни: 1=Пн … 5=Пт. room: null — кабинет пока неизвестен (заполни!)
const L = (subject, room, teacher) => ({ subject, room, teacher });
const KURATOR = L("Цифровой куратор", "509", "Манеева А.В.");
const BASE = {
  1: { 1: L("Математика", "212", "Бронникова Е.Н."), 2: L("Информатика", "301", "Романова О.В."),
       3: L("Основы алгоритмизации и программирования", null, "Мережникова Е.И."),
       4: L("Основы алгоритмизации и программирования", null, "Мережникова Е.И.") },
  2: { 1: L("Основы информационной безопасности", null, "Бирюкова О.Н."),
       2: L("Иностранный язык в проф. деятельности", "208", "Федосова Н.Р.") },
  3: { 1: KURATOR, 2: KURATOR, 3: L("Сети и системы передачи данных", null, "Прищепа Е.А."),
       4: L("Физкультура", "спортзал", "Бахирева Н.А.") },
  4: { 1: L("Математика", "212", "Бронникова Е.Н."),
       2: L("Основы алгоритмизации и программирования", null, "Мережникова Е.И."),
       3: L("Основы информационной безопасности", null, "Бирюкова О.Н.") },
  5: { 1: L("Сети и системы передачи данных", null, "Прищепа Е.А."), 2: L("Информатика", "301", "Романова О.В."),
       3: KURATOR, 4: KURATOR }
};

// ===== ВСПОМОГАТЕЛЬНОЕ =====
const SIM_NOW = null; // тест: например "2026-11-02T19:35:00" — скрипт только покажет план в консоли и ничего не поставит
const NOW = SIM_NOW ? new Date(SIM_NOW) : new Date();
const pad = n => String(n).padStart(2, "0");
const dateKey = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const at = (d, hhmm) => { const [h, m] = hhmm.split(":").map(Number); const x = new Date(d); x.setHours(h, m, 0, 0); return x; };
const plus = (d, min) => new Date(d.getTime() + min * 60000);
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const fmt = d => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const norm = s => (s || "").toLowerCase().replace(/[^а-яa-z0-9]/g, "");
const desc = l => {
  const was = l.was && l.was.room && l.room && norm(l.was.subject) === norm(l.subject) && l.was.room !== l.room ? ` (было ${l.was.room})` : "";
  return `${l.mark ? l.mark + " " : ""}${l.subject}${l.room ? ", каб. " + l.room + was : ""}${l.teacher ? ", " + l.teacher : ""}`;
};

async function loadReplacements() {
  try {
    if (REPLACEMENTS_URL) { const d = await new Request(REPLACEMENTS_URL).loadJSON(); console.log(`Замен с сервера: ${d.length}`); return d.concat(MANUAL_REPLACEMENTS); }
    const fm = FileManager.iCloud(); const p = fm.joinPath(fm.documentsDirectory(), "replacements.json");
    if (!fm.fileExists(p)) { console.log("replacements.json не найден в папке Scriptable — берём MANUAL_REPLACEMENTS"); return MANUAL_REPLACEMENTS; }
    await fm.downloadFileFromiCloud(p);
    const data = JSON.parse(fm.readString(p));
    console.log(`Замен загружено: ${data.length}`);
    return data.concat(MANUAL_REPLACEMENTS);
  } catch (e) { console.warn("Замены не загружены: " + e); return []; }
}

// Итоговые пары на дату: основное расписание → «Ленты нет» очищает → строки замен перезаписывают
function lessonsFor(date, repl) {
  const wd = date.getDay();
  const day = Object.assign({}, BASE[wd] || {});
  const base = Object.keys(day).length;
  const r = (repl || []).filter(x => x.date === dateKey(date) && !x.check).pop();
  if (r) {
    (r.cancel || []).forEach(n => delete day[n]);
    Object.entries(r.lessons || {}).forEach(([n, v]) => {
      const b = (BASE[wd] || {})[n];
      const nv = Object.assign({}, v);
      const same = b && norm(b.subject) === norm(nv.subject);
      if (same && !nv.room) nv.room = b.room;            // кабинет в замене не указан → прежний
      if (b) nv.was = b;
      if (!same || (nv.teacher && b && b.teacher !== nv.teacher)) nv.mark = "Замена:";
      day[n] = nv;
    });
  }
  const list = Object.keys(day).map(Number).sort((a, b) => a - b).map(n => Object.assign({ n }, day[n]));
  return { list, base };
}

// ===== УВЕДОМЛЕНИЯ =====
const PREFIX = "pary-";
async function notify(id, title, body, when) {
  if (when <= plus(NOW, 0.1)) return false;
  if (SIM_NOW) { console.log(`[тест] ${fmt(when)} (${dateKey(when)}) ${title}: ${body.replace(/\n/g, " | ")}`); return true; }
  const n = new Notification();
  n.identifier = PREFIX + id; n.title = title; n.body = body; n.threadIdentifier = "pary";
  n.sound = "default"; n.setTriggerDate(when);
  await n.schedule();
  console.log(`${fmt(when)} (${dateKey(when)}) ${title}: ${body.replace(/\n/g, " | ")}`);
  return true;
}

async function planDay(date, repl) {
  const all = lessonsFor(date, repl).list;
  const list = all.filter(l => BELLS[l.n]);
  all.filter(l => !BELLS[l.n]).forEach(l => console.log(`${dateKey(date)}: для ${l.n}-й пары нет времени в BELLS, уведомления по ней пропущены`));
  const k = dateKey(date);
  if (!list.length) { console.log(`${k}: пар нет`); return; }
  const first = list[0];
  // Утро: когда выходить
  let target = at(date, BELLS[first.n][0]);
  let extra = "";
  if (date.getDay() === 1 && MONDAY_ASSEMBLY && first.n === 1) { target = at(date, MONDAY_ASSEMBLY); extra = `\nВ ${MONDAY_ASSEMBLY} «Разговоры о важном»`; }
  const leave = plus(target, -(TRAVEL_MIN + BUFFER_MIN));
  await notify(`${k}-morning`, `Выходить в ${fmt(leave)}`,
    `${first.n}-я пара в ${BELLS[first.n][0]} — ${desc(first)}${extra}`, plus(leave, -MORNING_LEAD));
  // Следующая пара за 15 минут до конца текущей
  for (let i = 0; i < list.length - 1; i++) {
    const cur = list[i], nxt = list[i + 1];
    const gap = nxt.n !== cur.n + 1 ? ` (начало ${BELLS[nxt.n][0]})` : "";
    await notify(`${k}-next${nxt.n}`, "Следующая пара", `${nxt.n}-я пара${gap} — ${desc(nxt)}`, plus(at(date, BELLS[cur.n][1]), -NEXT_LEAD));
  }
  const last = list[list.length - 1];
  await notify(`${k}-end`, "Конец учебного дня", `через ${NEXT_LEAD} минут конец учебного дня`, plus(at(date, BELLS[last.n][1]), -NEXT_LEAD));
}

async function planEvening(today, repl) {
  const tomorrow = addDays(today, 1);
  const { list, base } = lessonsFor(tomorrow, repl);
  const when = at(today, EVENING_TIME);
  if (!list.length) {
    if (base) await notify(`${dateKey(tomorrow)}-evening`, "Завтра пар нет", "Все пары отменены, можно спать", when);
    return;
  }
  const f = list[0];
  const rest = list.slice(1).map(l => `${l.n} пара — ${l.subject}`).join("\n");
  await notify(`${dateKey(tomorrow)}-evening`, `завтра к ${f.n}-й паре`,
    `${f.n} пара — ${desc(f)}` + (rest ? `\nостальные пары:\n${rest}` : ""), when);
}

// ===== ИЗМЕНЕНИЯ МЕЖДУ ЗАПУСКАМИ =====
const sf = FileManager.local(); const statePath = sf.joinPath(sf.documentsDirectory(), "pary-state.json");
const oldState = sf.fileExists(statePath) ? JSON.parse(sf.readString(statePath)) : {};
const newState = {};
const sig = list => Object.fromEntries(list.map(l => [l.n, { s: l.subject, r: l.room || "", t: l.teacher || "" }]));
const sdesc = x => `${x.s}${x.r ? ", каб. " + x.r : ""}${x.t ? ", " + x.t : ""}`;

async function detect(date, label, repl) {
  const k = dateKey(date), cur = sig(lessonsFor(date, repl).list), prev = oldState[k];
  newState[k] = cur;
  if (!prev) return;
  const lines = [];
  [...new Set([...Object.keys(prev), ...Object.keys(cur)])].sort().forEach(n => {
    if (!cur[n]) lines.push(`${n} пара отменена`);
    else if (!prev[n]) lines.push(`${n} пара добавлена: ${sdesc(cur[n])}`);
    else if (JSON.stringify(prev[n]) !== JSON.stringify(cur[n])) {
      const roomOnly = prev[n].s === cur[n].s && prev[n].t === cur[n].t;
      lines.push(roomOnly ? `${n} пара: ${cur[n].s} — теперь каб. ${cur[n].r || "?"} (было ${prev[n].r || "?"})` : `${n} пара: ${sdesc(cur[n])}`);
    }
  });
  if (lines.length) await notify(`${k}-change`, `Изменение на ${label}`, lines.join("\n"), plus(NOW, 0.2));
}

// ===== ЗАПУСК =====
const pending = await Notification.allPending();
const old = pending.filter(n => (n.identifier || "").startsWith(PREFIX)).map(n => n.identifier);
if (old.length && !SIM_NOW) Notification.removePending(old);

const repl = await loadReplacements();
await detect(NOW, "сегодня", repl);
await detect(addDays(NOW, 1), "завтра", repl);
// Лист замен вышел, но бот не смог его прочитать — один раз предупредить
const chk = (oldState._chk || []).filter(k => k === dateKey(NOW) || k === dateKey(addDays(NOW, 1)));
for (const d of [NOW, addDays(NOW, 1)]) {
  const k = dateKey(d);
  const c = repl.find(x => x.date === k && x.check);
  if (c && !chk.includes(k)) { await notify(`${k}-check`, "Замены не разобраны", "Лист замен вышел, но бот не смог его прочитать. Открой группу ВК.", plus(NOW, 0.2)); chk.push(k); }
}
newState._chk = chk;
if (!SIM_NOW) sf.writeString(statePath, JSON.stringify(newState));
await planDay(NOW, repl);
await planDay(addDays(NOW, 1), repl);
await planEvening(NOW, repl);
console.log("Готово");
Script.complete();
