import { mkdir, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

/**
 * Shell integration for board terminals (12.6a): zsh and bash load the user's own startup files
 * as usual, then report each command with OSC 133/633 markers (`shell-markers.ts`). Nothing in
 * the user's dotfiles changes: zsh starts with `ZDOTDIR` pointing at wrapper files that source the
 * real ones, bash with an `--rcfile` that does the same.
 */

export interface ShellLaunch {
  file: string;
  args: string[];
  env: Record<string, string>;
}

export type IntegratedShell = 'zsh' | 'bash';

/** Which integration a shell gets, by its program name; null for fish, nu, sh and the rest. */
export function integrationFor(file: string): IntegratedShell | null {
  const name = basename(file).replace(/^-/, '');
  return name === 'zsh' || name === 'bash' ? name : null;
}

// Shared by both shells: the escaping 633 E/P values need (`\`, `;` and control characters).
const ESCAPE = String.raw`__cboard_esc() {
  local s=$1 bs='\'
  s=\${s//"$bs"/"$bs$bs"}
  s=\${s//;/"\${bs}x3b"}
  s=\${s//$'\n'/"\${bs}x0a"}
  s=\${s//$'\r'/"\${bs}x0d"}
  s=\${s//$'\a'/"\${bs}x07"}
  s=\${s//$'\e'/"\${bs}x1b"}
  REPLY=$s
}
`.replaceAll('\\${', '${');

const HEADER = '# c-board shell integration. Written by the c-board server on each start.\n';

const ZSH_HOOKS = `${HEADER}${ESCAPE}
__cboard_running=0
__cboard_precmd() {
  local code=$?
  if (( __cboard_running )); then
    builtin printf '\\033]133;D;%s\\007' "$code"
    __cboard_running=0
  fi
  __cboard_esc "$PWD"
  builtin printf '\\033]633;P;Cwd=%s\\007\\033]133;A\\007' "$REPLY"
}
__cboard_preexec() {
  __cboard_esc "$1"
  builtin printf '\\033]633;E;%s\\007\\033]133;C\\007' "$REPLY"
  __cboard_running=1
}
# First, so it still sees the command's exit status.
precmd_functions=(__cboard_precmd \${precmd_functions[@]})
preexec_functions+=(__cboard_preexec)
`;

/** Sources the user's own copy of a zsh startup file, with their ZDOTDIR in place meanwhile. */
const zshSource = (name: string) => `if [[ -f "\${CBOARD_USER_ZDOTDIR:-$HOME}/${name}" ]]; then
  __cboard_zdotdir=$ZDOTDIR
  ZDOTDIR=\${CBOARD_USER_ZDOTDIR:-$HOME}
  builtin source "$ZDOTDIR/${name}"
  CBOARD_USER_ZDOTDIR=$ZDOTDIR
  ZDOTDIR=$__cboard_zdotdir
  unset __cboard_zdotdir
fi
`;

/** Hands ZDOTDIR back, so a zsh started from this one reads the user's files directly. */
const ZSH_RESTORE = `ZDOTDIR=\${CBOARD_USER_ZDOTDIR:-$HOME}
unset CBOARD_USER_ZDOTDIR
`;

const ZSH_FILES: Record<string, string> = {
  '.zshenv': `${HEADER}${zshSource('.zshenv')}`,
  '.zprofile': `${HEADER}${zshSource('.zprofile')}`,
  '.zshrc': `${HEADER}${zshSource('.zshrc')}builtin source "\${ZDOTDIR}/c-board.zsh"
if [[ ! -o login ]]; then
${ZSH_RESTORE}fi
`,
  '.zlogin': `${HEADER}${zshSource('.zlogin')}${ZSH_RESTORE}`,
  'c-board.zsh': ZSH_HOOKS,
};

const BASH_RC = `${HEADER}if [[ \${CBOARD_BASH_LOGIN-} == 1 ]]; then
  unset CBOARD_BASH_LOGIN
  [[ -r /etc/profile ]] && builtin source /etc/profile
  for __cboard_profile in ~/.bash_profile ~/.bash_login ~/.profile; do
    if [[ -r $__cboard_profile ]]; then
      builtin source "$__cboard_profile"
      break
    fi
  done
  unset __cboard_profile
elif [[ -r ~/.bashrc ]]; then
  builtin source ~/.bashrc
fi

${ESCAPE}
__cboard_running=0
__cboard_in_prompt=0
__cboard_ready=0
__cboard_histnum=
__cboard_preexec() {
  [[ $__cboard_ready == 1 && $__cboard_in_prompt == 0 && $__cboard_running == 0 ]] || return 0
  [[ -n \${COMP_LINE-} || $BASH_COMMAND == __cboard_* ]] && return 0
  __cboard_running=1
  local entry line=$BASH_COMMAND
  entry=$(HISTTIMEFORMAT='' builtin history 1)
  # "  42  echo hi": newer than the last one seen means it holds the whole line as typed.
  if [[ $entry =~ ^[[:space:]]*([0-9]+)[*]?[[:space:]]+(.*)$ ]]; then
    if [[ \${BASH_REMATCH[1]} != "$__cboard_histnum" ]]; then
      line=\${BASH_REMATCH[2]}
      __cboard_histnum=\${BASH_REMATCH[1]}
    fi
  fi
  __cboard_esc "$line"
  builtin printf '\\033]633;E;%s\\007\\033]133;C\\007' "$REPLY"
  return 0
}
__cboard_prompt() {
  if [[ $__cboard_running == 1 ]]; then
    builtin printf '\\033]133;D;%s\\007' "$__cboard_status"
  fi
  __cboard_running=0
  __cboard_esc "$PWD"
  builtin printf '\\033]633;P;Cwd=%s\\007\\033]133;A\\007' "$REPLY"
  __cboard_in_prompt=0
  __cboard_ready=1
}
[[ $(HISTTIMEFORMAT='' builtin history 1) =~ ^[[:space:]]*([0-9]+) ]] && __cboard_histnum=\${BASH_REMATCH[1]}
PROMPT_COMMAND="__cboard_status=\\$?; __cboard_in_prompt=1
\${PROMPT_COMMAND:-}
__cboard_prompt"
trap '__cboard_preexec' DEBUG
`;

/** Writes the wrapper files into `dir` (replacing what an earlier start left). */
export async function writeShellIntegration(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
  await mkdir(join(dir, 'zsh'), { recursive: true, mode: 0o700 });
  await mkdir(join(dir, 'bash'), { recursive: true, mode: 0o700 });
  for (const [name, content] of Object.entries(ZSH_FILES)) {
    await writeFile(join(dir, 'zsh', name), content, { mode: 0o600 });
  }
  await writeFile(join(dir, 'bash', 'rc.bash'), BASH_RC, { mode: 0o600 });
}

/**
 * How to start `shell` with the integration in `dir`, or the shell unchanged when it has none.
 * zsh keeps its arguments and gets `ZDOTDIR`; bash trades `-l` for an rcfile that loads the
 * login profile itself (bash ignores `--rcfile` in a login shell).
 */
export function integrateShell(
  shell: { file: string; args: string[] },
  env: Record<string, string>,
  dir: string,
): ShellLaunch & { integration: IntegratedShell | null } {
  const integration = integrationFor(shell.file);
  if (integration === 'zsh') {
    const next: Record<string, string> = {
      ...env,
      ZDOTDIR: join(dir, 'zsh'),
      CBOARD_USER_ZDOTDIR: env.ZDOTDIR ?? env.HOME ?? '',
    };
    return { file: shell.file, args: shell.args, env: next, integration };
  }
  if (integration === 'bash') {
    const login = shell.args.some((arg) => arg === '-l' || arg === '--login');
    const args = shell.args.filter((arg) => arg !== '-l' && arg !== '--login');
    const next: Record<string, string> = { ...env };
    if (login) next.CBOARD_BASH_LOGIN = '1';
    return {
      file: shell.file,
      args: ['--rcfile', join(dir, 'bash', 'rc.bash'), ...args],
      env: next,
      integration,
    };
  }
  return { ...shell, env, integration: null };
}
