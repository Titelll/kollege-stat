#!/usr/bin/env python3
"""Читает стену ВК-группы, распознаёт листы замен и пишет replacements.json для группы БИАС-14.
Запуск: python parse_vk.py            (нужен VK_TOKEN в окружении)
Тест:   python parse_vk.py foto.jpg   (разобрать локальное фото листа)"""
import os, re, sys, json, difflib, datetime as dt
import requests, cv2, numpy as np, pytesseract
from pytesseract import Output

DOMAIN = os.environ.get("VK_DOMAIN", "sibsau_muta")
TZ = dt.timezone(dt.timedelta(hours=7))  # Красноярск
HOSTS = ["https://api.vk.com", "https://api.vk.ru"]
CACHE, OUT = "cache.json", "replacements.json"
DAYS = {"понедельник": 0, "вторник": 1, "среда": 2, "четверг": 3, "пятница": 4}
LAT = str.maketrans("ABCEHKMOPTXY", "АВСЕНКМОРТХУ")
ROW = re.compile(r"^\W*([A-Za-zА-Яа-я]{1,6})\s*[-–—]?\s*([0-9Il|!]{1,3})\s+(.*)$")


LOOSE = re.compile(r"[БB][ИU][АA][СC]\W{0,2}[1Il|]\W{0,2}4\s+(.*)$", re.I)


def vk(method, **p):
    p.update(access_token=os.environ["VK_TOKEN"], v="5.199")
    last = None
    for h in HOSTS:
        try:
            r = requests.get(f"{h}/method/{method}", params=p, timeout=30).json()
            if "error" in r:
                raise RuntimeError(r["error"].get("error_msg"))
            return r["response"]
        except Exception as e:
            last = e
            print("VK недоступен через", h, "-", e)
    raise SystemExit(f"VK API не ответил: {last}")


# ---------- распознавание ----------
def deskew(gray):
    h, w = gray.shape
    lines = cv2.HoughLinesP(cv2.Canny(gray, 50, 150), 1, np.pi / 720, 200, minLineLength=w // 3, maxLineGap=20)
    if lines is None:
        return gray
    angs = [np.degrees(np.arctan2(y2 - y1, x2 - x1)) for x1, y1, x2, y2 in np.asarray(lines).reshape(-1, 4)]
    angs = [a for a in angs if abs(a) < 15]
    if not angs:
        return gray
    m = cv2.getRotationMatrix2D((w / 2, h / 2), float(np.median(angs)), 1.0)
    return cv2.warpAffine(gray, m, (w, h), flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE)


def lines_from(img, psm):
    d = pytesseract.image_to_data(img, lang="rus", config=f"--psm {psm}", output_type=Output.DICT)
    ws = [(d["top"][i] + d["height"][i] / 2, d["left"][i], d["text"][i], d["height"][i])
          for i in range(len(d["text"])) if d["text"][i].strip() and float(d["conf"][i]) > 20]
    if not ws:
        return []
    ws.sort()
    tol = 0.6 * float(np.median([w[3] for w in ws]))
    lines, cur = [], [ws[0]]
    for w in ws[1:]:
        if abs(w[0] - cur[-1][0]) > tol:
            lines.append(cur); cur = []
        cur.append(w)
    lines.append(cur)
    return [" ".join(x[2] for x in sorted(l, key=lambda t: t[1])) for l in lines]


def header_lines(img):
    top = cv2.cvtColor(img[: int(img.shape[0] * 0.4)], cv2.COLOR_BGR2GRAY)
    k = 1800 / top.shape[1]
    top = cv2.resize(top, None, fx=k, fy=k, interpolation=cv2.INTER_CUBIC)
    return lines_from(top, 6)


def best_lines(img):
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    if gray.shape[1] < 2400:
        k = 2400 / gray.shape[1]
        gray = cv2.resize(gray, None, fx=k, fy=k, interpolation=cv2.INTER_CUBIC)
    gray = deskew(gray)
    thr = cv2.adaptiveThreshold(gray, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY, 41, 15)
    best, score = [], -1
    inv = 255 - thr  # третий вариант: убрать линии таблицы
    grid = cv2.add(cv2.morphologyEx(inv, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_RECT, (80, 1))),
                   cv2.morphologyEx(inv, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_RECT, (1, 80))))
    clean = 255 - cv2.subtract(inv, cv2.dilate(grid, np.ones((3, 3), np.uint8)))
    for variant in (gray, thr, clean):
        for psm in (6, 4):
            ls = lines_from(variant, psm)
            s = sum(1 for l in ls if ROW.match(l))
            if s > score:
                best, score = ls, s
    return best


# ---------- разбор ----------
def is_mine(letters, digits):
    L = letters.upper().translate(LAT)
    return len(L) == 4 and difflib.SequenceMatcher(None, L, "БИАС").ratio() >= 0.75 \
        and re.sub(r"[Il|!]", "1", digits) == "14"


def weekday(head):
    for w in re.findall(r"[А-Яа-яЁё]{5,}", " ".join(head).lower()):
        m = difflib.get_close_matches(w, DAYS, n=1, cutoff=0.75)
        if m:
            return DAYS[m[0]]
    return None


def header_date(head):
    m = re.search(r"(\d{1,2})[.,](\d{1,2})[.,](20\d\d)", " ".join(head))
    try:
        return dt.date(int(m.group(3)), int(m.group(2)), int(m.group(1))) if m else None
    except ValueError:
        return None


def parse_rest(rest):
    """-> ('cancel', [пары]) | ('lesson', [пары], dict) | None"""
    rest = rest.lstrip(" |_—–-.,;:")
    m = re.match(r"^([0-9Il/\\]+)\s+(.*)$", rest)
    if not m:
        return None
    pairs = sorted({int(x) for x in re.findall(r"[1-8]", re.sub(r"[Il]", "1", m.group(1)))})
    body = m.group(2).strip()
    if not pairs:
        return None
    if re.search(r"нет", body, re.I):
        return ("cancel", pairs)
    room = None
    r = re.search(r"\s([Сс]\s*/\s*[зЗ]\w{1,2}|[СC]\s?-\s?\d{1,3}|ЛЩ\s?\d{3}|Л\s?\d{3}|\d{3})\s*$", " " + body)
    if r:
        room = "спортзал" if "/" in r.group(1) else r.group(1).replace(" ", "").replace("C", "С")
        body = (" " + body)[:r.start()].strip()
    teacher = None
    t = re.search(r"([А-ЯЁ][а-яё]{2,})\s+([А-ЯЁ])\.?\s?([А-ЯЁ])\.?\s*$", body)
    if t:
        teacher = f"{t.group(1)} {t.group(2)}.{t.group(3)}."
        body = body[:t.start()].strip()
    return ("lesson", pairs, {"subject": body.strip(" |-_"), "room": room, "teacher": teacher})


def analyse(img, post_date, url):
    head = header_lines(img)
    if not re.search(r"ИЗМЕН|РАСПИС", " ".join(head).upper()):
        return None  # не лист замен
    lines = best_lines(img)
    rows = [(ROW.match(l)) for l in lines]
    rows = [m for m in rows if m]
    mine = []
    for l in lines:
        m = ROW.match(l)
        if m and is_mine(m.group(1), m.group(2)):
            mine.append((l, m.group(3)))
        elif LOOSE.search(l):
            mine.append((l, LOOSE.search(l).group(1)))
    for l, _ in mine:
        print("  БИАС-14:", l)
    wd = weekday(head)
    hd = header_date(head)
    print(f"  строк с группами: {len(rows)}, день недели: {wd}, строк БИАС-14: {len(mine)}")
    if len(rows) < 8 or (wd is None and hd is None):
        for l in lines[:70]:
            print("   |", l)
    cancel, lessons, bad = [], {}, False
    for _, rest in mine:
        res = parse_rest(rest)
        if not res:
            bad = True
        elif res[0] == "cancel":
            cancel += res[1]
        else:
            for n in res[1]:
                lessons[str(n)] = res[2]
    if len(rows) >= 8 and not mine:
        return None  # лист прочитан, для нашей группы изменений нет
    if wd is not None:
        date = post_date + dt.timedelta(days=(wd - post_date.weekday()) % 7)
    elif hd:
        date = hd  # день недели не написан — берём дату из шапки
    else:
        date = post_date + dt.timedelta(days=1)
    e = {"date": str(date), "post": url}
    if len(rows) < 8 or (wd is None and hd is None) or bad:
        e["check"] = True
    else:
        e.update(cancel=sorted(set(cancel)), lessons=lessons)
    return e


# ---------- запуск ----------
def main():
    if os.path.exists("test.jpg"):  # проверка на реальном фото листа, положенном в репозиторий
        print("ТЕСТ по файлу test.jpg:", analyse(cv2.imread("test.jpg"), dt.date.today(), "test"))
    cache = json.load(open(CACHE)) if os.path.exists(CACHE) else {}
    seen, new = set(), 0
    today0 = dt.datetime.now(TZ).date()
    for p in vk("wall.get", domain=DOMAIN, count=15)["items"]:
        pd = dt.datetime.fromtimestamp(p["date"], TZ).date()
        if (today0 - pd).days > 7:
            continue
        for a in p.get("attachments", []):
            if a["type"] != "photo":
                continue
            ph = a["photo"]
            key = f'{p["id"]}_{ph["id"]}'
            seen.add(key)
            if (key in cache and not (cache[key] or {}).get("check")) or new >= 8:
                continue
            new += 1
            try:
                url = max(ph["sizes"], key=lambda s: s["width"] * s["height"])["url"]
                img = cv2.imdecode(np.frombuffer(requests.get(url, timeout=60).content, np.uint8), cv2.IMREAD_COLOR)
                print("Разбираю фото", key)
                cache[key] = analyse(img, pd, f'https://vk.com/wall{p["owner_id"]}_{p["id"]}')
                print("  результат:", cache[key])
            except Exception as ex:
                print("Ошибка на", key, ex)
    cache = {k: v for k, v in cache.items() if k in seen}
    limit = str(dt.datetime.now(TZ).date() - dt.timedelta(days=3))
    out = sorted((e for e in cache.values() if e and e["date"] >= limit), key=lambda e: e["date"])
    json.dump(out, open(OUT, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    json.dump(cache, open(CACHE, "w", encoding="utf-8"), ensure_ascii=False, indent=1)


if __name__ == "__main__":
    if len(sys.argv) > 1:
        print(analyse(cv2.imread(sys.argv[1]), dt.date.today(), "test"))
    else:
        main()
