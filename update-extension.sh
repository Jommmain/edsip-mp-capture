#!/usr/bin/env bash
# Обновление расширения EDSIP MP Capture на Mac "на месте" (путь не меняется -> Chrome просто жмёт ⟳).
# Идемпотентно: если версия та же — ничего не делает. Запуск: bash update-extension.sh [--force]
#
# Режимы:
#   release (по умолчанию) — скачивает zip последнего GitHub Release и распаковывает в DEST
#   git                    — EDSIP_MODE=git: git pull --ff-only в клоне EDSIP_GIT_DIR, затем синхронизирует подпапку в DEST
#
# Настройки (env):
#   EDSIP_REPO      owner/repo                         (по умолчанию Jommmain/edsip-mp-capture)
#   EDSIP_DEST      папка, загруженная как unpacked    (по умолчанию ~/EDSIP/edsip-mp-capture)
#   EDSIP_ASSET     шаблон имени zip в релизе         (по умолчанию edsip-mp-capture-*.zip)
#   EDSIP_GIT_DIR   клон репозитория (режим git)       (по умолчанию ~/EDSIP/repo)
#   EDSIP_GIT_SUBDIR подпапка расширения в репо        (по умолчанию . ; для монорепо: tools/edsip-mp-capture)
#   GITHUB_TOKEN    необязательно: токен только на чтение — лишь от лимита GitHub API (60 запросов/час без авторизации)
# Репозиторий публичный: работает без авторизации. Если curl не смог (лимит/сеть) и есть `gh auth login` — пробует gh.
set -euo pipefail

REPO="${EDSIP_REPO:-Jommmain/edsip-mp-capture}"
DEST="${EDSIP_DEST:-$HOME/EDSIP/edsip-mp-capture}"
ASSET="${EDSIP_ASSET:-edsip-mp-capture-*.zip}"
MODE="${EDSIP_MODE:-release}"
GIT_DIR_="${EDSIP_GIT_DIR:-$HOME/EDSIP/repo}"
GIT_SUBDIR="${EDSIP_GIT_SUBDIR:-.}"
FORCE=0; [[ "${1:-}" == "--force" ]] && FORCE=1

say() { printf '› %s\n' "$*"; }
die() { printf '✗ %s\n' "$*" >&2; exit 1; }
ver_of() { [[ -f "$1/manifest.json" ]] && /usr/bin/python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["version"])' "$1/manifest.json" 2>/dev/null || echo "none"; }

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
mkdir -p "$DEST"
OLD="$(ver_of "$DEST")"

if [[ "$MODE" == "git" ]]; then
  [[ -d "$GIT_DIR_/.git" ]] || die "Нет клона $GIT_DIR_ (сделайте один раз: git clone https://github.com/$REPO.git \"$GIT_DIR_\")"
  say "git pull в $GIT_DIR_"
  git -C "$GIT_DIR_" pull --ff-only --quiet
  SRC="$GIT_DIR_/$GIT_SUBDIR"
else
  say "Скачиваю последний релиз $REPO через GitHub API${GITHUB_TOKEN:+ (с GITHUB_TOKEN)}"
  AUTH=(); [[ -n "${GITHUB_TOKEN:-}" ]] && AUTH=(-H "Authorization: Bearer $GITHUB_TOKEN")
  URL=""
  if API="$(curl -fsSL ${AUTH[@]+"${AUTH[@]}"} -H "Accept: application/vnd.github+json" "https://api.github.com/repos/$REPO/releases/latest")"; then
    URL="$(printf '%s' "$API" | /usr/bin/python3 -c 'import json,sys,fnmatch;p=sys.argv[1];a=[x["browser_download_url"] for x in json.load(sys.stdin).get("assets",[]) if fnmatch.fnmatch(x["name"],p)];print(a[0] if a else "")' "$ASSET")"
    [[ -n "$URL" ]] || die "В последнем релизе нет файла $ASSET"
    curl -fsSL -o "$TMP/ext.zip" "$URL" || URL=""
  fi
  if [[ -z "$URL" ]]; then
    if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
      say "GitHub API недоступен (лимит/сеть) — пробую через gh"
      gh release download --repo "$REPO" --pattern "$ASSET" --dir "$TMP" --clobber
    else
      die "Не удалось получить релиз $REPO (лимит GitHub API или нет сети). Повторите позже или задайте GITHUB_TOKEN."
    fi
  fi
  ZIP="$(ls "$TMP"/*.zip 2>/dev/null | head -1)"; [[ -n "$ZIP" ]] || die "zip не скачан"
  mkdir "$TMP/x" && /usr/bin/unzip -q "$ZIP" -d "$TMP/x"
  SRC="$TMP/x"
  # zip с вложенной папкой -> взять папку, где лежит manifest.json
  [[ -f "$SRC/manifest.json" ]] || SRC="$(dirname "$(find "$TMP/x" -name manifest.json -maxdepth 3 | head -1)")"
fi

[[ -f "$SRC/manifest.json" ]] || die "В источнике нет manifest.json"
/usr/bin/python3 -c 'import json,sys;m=json.load(open(sys.argv[1]));assert m.get("manifest_version")==3' "$SRC/manifest.json" \
  || die "manifest.json не MV3 / битый — обновление отменено, текущая версия не тронута"
NEW="$(ver_of "$SRC")"

if [[ "$NEW" == "$OLD" && $FORCE -eq 0 ]]; then say "Уже актуально: $OLD ($DEST)"; exit 0; fi

# Замена содержимого на месте (путь тот же). Бэкап предыдущей версии рядом.
if [[ "$OLD" != "none" ]]; then rm -rf "$DEST.prev" && cp -R "$DEST" "$DEST.prev"; fi
if command -v rsync >/dev/null 2>&1; then
  rsync -a --delete --exclude '.git' --exclude 'tests/' --exclude '.DS_Store' "$SRC"/ "$DEST"/
else  # без rsync: очистить содержимое (сама папка остаётся) и скопировать
  find "$DEST" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
  (cd "$SRC" && tar --exclude .git --exclude tests --exclude .DS_Store -cf - .) | (cd "$DEST" && tar -xf -)
fi
say "Обновлено: $OLD → $NEW в $DEST"
say "Дальше: chrome://extensions → EDSIP MP Capture → ⟳ (Перезагрузить), затем F5 на открытых вкладках WB/Ozon."
if [[ "$OLD" != "none" ]]; then
  say "Откат: rm -rf \"$DEST\" && mv \"$DEST.prev\" \"$DEST\" и снова ⟳."
else
  say "Первая установка: chrome://extensions → Режим разработчика → «Загрузить распакованное» → $DEST"
fi
