# code-quality: скилл, плагин или связка (23.09.2026)


## 1. Вывод
1. Нужна связка: ядро `quality.ts` + тонкие плагины под каждую среду (хук + скилл внутри). Одного скилла мало: по стандарту agentskills.io скилл грузится, только когда модель сочтёт задачу подходящей. Хук среда запускает сама (https://code.claude.com/docs/en/hooks-guide: «deterministic control… rather than relying on the LLM»).
2. Гейт уже держится на хуках (Stop в Claude и Codex, extension pi, git-хуки). Дыры: подключение руками на одной машине, запрета `--no-verify` нет.
3. Плагин даёт установку одной командой, обновление по версии и включение на репо для всей команды.
4. Общего стандарта хуков нет (Agent Plugins 1.0, https://agent-plugins.org/, покрывает только skills и MCP). Формат хуков Claude фактически общий: его читают Claude, Codex и Grok.

## 2. Среды

| Среда | Skills | После хода | Перед вызовом инструмента | Упаковка | Сейчас | Поменять |
|---|---|---|---|---|---|---|
| Claude Code | SKILL.md (https://code.claude.com/docs/en/skills) | `Stop` block+reason | `PreToolUse` Bash, deny / exit 2 | `.claude-plugin/plugin.json`, `hooks/hooks.json`, `${CLAUDE_PLUGIN_ROOT}`, маркетплейс, `--scope project` пишет `enabledPlugins` в `.claude/settings.json`; папка скилла с манифестом грузится как `@skills-dir` (https://code.claude.com/docs/en/plugins-reference) | Stop вручную в `~/.claude/settings.json` | Плагин: Stop + PreToolUse, скилл внутри |
| Codex CLI | `.agents/skills` (https://developers.openai.com/codex/skills) | `Stop`, тот же контракт (https://developers.openai.com/codex/hooks) | `PreToolUse`, `permissionDecision: deny` | `.codex-plugin/plugin.json` или portable, `hooks/hooks.json`, задаёт `CLAUDE_PLUGIN_ROOT`, принимает `.claude-plugin/marketplace.json` (https://developers.openai.com/plugins/build/plugins). Хуки доверять, доверие по хэшу | Stop вручную в `~/.codex/hooks.json` | Тот же плагин; после обновления доверить в `/hooks` |
| pi 0.87 | `.agents/skills` | `agent_before_settle` (одно продолжение); `agent_settled` только уведомление | `tool_call` → `{block:true}` | Пакет `pi install npm:/git:`, `-l` пишет `.pi/settings.json` | Симлинк на `agent_settled`, живьём не проверен | Пакет на `agent_before_settle` + `tool_call` |
| opencode | `.opencode/skills`, `.claude/skills`, `.agents/skills` | `session.idle`, не блокирует (https://opencode.ai/docs/plugins/) | `tool.execute.before` + throw | JS/TS в `.opencode/plugins/` или npm в `opencode.json` | нет | npm-плагин, если пойдёт в работу |
| bb | `.bb/skills` | `thread.idle`, уведомление | своего нет; работают хуки провайдера (Claude с `settingSources` user/project/local) | `bb plugin install` | нет | свой плагин не нужен; проверить Stop в треде bb |
| Grok CLI 1.0.40 | `.grok/skills`, `~/.claude/skills`, `.agents/skills` | `Stop` в формате Claude | `PreToolUse` (`Bash` = `run_terminal_command`) | `grok plugin install owner/repo --trust`, принимает `.claude-plugin/` | Наш Stop уже срабатывает через `~/.claude/settings.json`; ключ сессии пустой (`sessionId` vs `session_id`, `lib/hooks.ts:392`) | Тот же плагин; ядро читает оба ключа |

## 3. Дрейф и дыры
- Без модели срабатывают: git-хуки, Stop в Claude/Codex, extension pi, хуки плагинов. От модели зависит только скилл, он нужен для ручных команд.
- Обход git-хуков: `--no-verify`/`-n`, `-c core.hooksPath=…`. PreToolUse-запрета нет. Строковая проверка не ловит обёртки; полностью закрывает только CI.
- Подключение руками на одной машине, без версии.
- Codex: правка меняет хэш, хук молча пропускается до `/hooks`.
- pi: адаптер на событии-уведомлении, не проверен.
- Grok: общий счётчик блоков у всех сессий.
- Субагенты: их правки проверит только Stop родителя (`SubagentStop` не проверял).

## 4. Архитектура
Один репо с тегами: `core/` (quality.ts + команда `guard-bash`), `git-hooks/` (переименовать из `hooks/`), `skills/code-quality/SKILL.md`, `.claude-plugin/plugin.json` + `marketplace.json` (Claude, Codex, Grok), `hooks/hooks.json` (Stop → agent-stop, PreToolUse Bash → guard-bash), `pi/` пакет, `opencode/` плагин. В упаковках нет логики. Включение на репо: `.claude/settings.json` (`extraKnownMarketplaces`, `enabledPlugins`), `.codex/config.toml`, `.pi/settings.json`, `opencode.json`, `.quality.toml`, CI-джоба.

## 5. План
1. `guard-bash` + PreToolUse в Claude и Codex, `tool_call` в pi; живой тест отказа на `--no-verify`.
2. Починить `sessionId` для Grok, pi на `agent_before_settle`; живые прогоны pi, Grok, bb.
3. Claude-плагин из текущей папки, ручную Stop-группу убрать, Stop срабатывает ровно раз.
4. Маркетплейс-репо, установка в Codex (доверие) и Grok, ручные записи убрать.
5. Пакет pi; opencode только если пойдёт в работу.
6. Включение в Iva и Splendor коммитом, CI-джоба с quality.ts.

## Не установлено
Продолжение хода из `session.idle` в opencode; грузит ли bb хуки Codex и pi; обход PreToolUse обёртками на практике.
