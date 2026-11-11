// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

//! Desktop Actions Execution for Isle XFCE.
//! Implements XFCE/GTK4-compatible execution of actions returned by isled assistant:
//! URLs, files/folders, applications, media playback, pomodoro focus,
//! to-do items, reminders, volume/audio, Wi-Fi, screen brightness, and command execution.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

/**
 * Runs a command argv via Gio.Subprocess and awaits its completion.
 * @param {string[]} argv
 * @returns {Promise<{ ok: boolean, detail: string }>}
 */
function runCommand(argv) {
    return new Promise(resolve => {
        let process;
        try {
            process = Gio.Subprocess.new(argv, Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
        } catch (e) {
            resolve({ ok: false, detail: e.message });
            return;
        }
        process.communicate_utf8_async(null, null, (_proc, res) => {
            try {
                const [, stdout, stderr] = process.communicate_utf8_finish(res);
                const ok = process.get_successful();
                const detail = ((ok ? stdout : stderr || stdout) ?? '').trim();
                resolve({ ok, detail: detail || (ok ? 'done' : 'command failed') });
            } catch (e) {
                resolve({ ok: false, detail: e.message });
            }
        });
    });
}

/**
 * Resolves ~ or relative paths to an absolute filesystem path.
 * @param {string} pathStr
 * @returns {string|null}
 */
function resolvePath(pathStr) {
    if (typeof pathStr !== 'string' || !pathStr.trim())
        return null;
    const home = GLib.get_home_dir();
    const expanded = pathStr.trim().replace(/^~(?=\/|$)/, home);
    return GLib.path_is_absolute(expanded) ? expanded : GLib.build_filenamev([home, expanded]);
}

/**
 * Validates and opens a web URL or email link.
 */
function handleOpenUrl(action) {
    const url = action.url ?? '';
    if (!/^(https?|mailto):/i.test(url))
        return { ok: false, detail: 'not a web address' };
    try {
        Gio.AppInfo.launch_default_for_uri(url, null);
        return { ok: true, detail: 'opened in the browser' };
    } catch (e) {
        return { ok: false, detail: e.message };
    }
}

/**
 * Opens a folder in the default file manager.
 */
function handleOpenFolder(action) {
    const path = resolvePath(action.path);
    if (!path)
        return { ok: false, detail: 'path is empty' };
    let folder = Gio.File.new_for_path(path);
    while (folder.get_parent() && !folder.query_exists(null))
        folder = folder.get_parent();
    try {
        Gio.AppInfo.launch_default_for_uri(folder.get_uri(), null);
        return { ok: true, detail: `opened ${folder.get_path()}` };
    } catch (e) {
        return { ok: false, detail: e.message };
    }
}

/**
 * Opens a file with its default handler.
 */
function handleOpenFile(action) {
    const path = resolvePath(action.path);
    if (!path)
        return { ok: false, detail: 'path is empty' };
    const file = Gio.File.new_for_path(path);
    if (!file.query_exists(null))
        return { ok: false, detail: 'file not found' };
    try {
        Gio.AppInfo.launch_default_for_uri(file.get_uri(), null);
        return { ok: true, detail: `opened ${path}` };
    } catch (e) {
        return { ok: false, detail: e.message };
    }
}

/**
 * Searches installed desktop applications by name or id and launches it.
 */
function handleOpenApp(action) {
    const target = (action.app ?? '').trim().toLowerCase();
    if (!target)
        return { ok: false, detail: 'no app specified' };
    const apps = Gio.AppInfo.get_all();
    const match = apps.find(app => (app.get_name() ?? '').toLowerCase() === target) ??
        apps.find(app => (app.get_name() ?? '').toLowerCase().includes(target)) ??
        apps.find(app => (app.get_id() ?? '').toLowerCase().includes(target.replace(/\s+/g, '')));
    if (!match)
        return { ok: false, detail: `no app called ${action.app}` };
    try {
        match.launch([], null);
        return { ok: true, detail: `${match.get_name()} is open` };
    } catch (e) {
        return { ok: false, detail: e.message };
    }
}

/**
 * Controls media playback via D-Bus daemon.
 */
async function handleMedia(action, daemon) {
    const method = { play_pause: 'PlayPause', next: 'Next', previous: 'Previous' }[action.command];
    if (!method)
        return { ok: false, detail: 'not a media command' };
    if (!daemon)
        return { ok: false, detail: 'daemon not connected' };
    try {
        await daemon.call('media', method);
        return { ok: true, detail: `media ${action.command}` };
    } catch (e) {
        return { ok: false, detail: e.message };
    }
}

/**
 * Controls pomodoro focus timer via D-Bus daemon.
 */
async function handleFocus(action, daemon) {
    if (!daemon)
        return { ok: false, detail: 'daemon not connected' };
    try {
        const method = action.command === 'stop' ? 'Stop' : 'Start';
        await daemon.call('pomodoro', method);
        return { ok: true, detail: `focus ${action.command ?? 'start'}` };
    } catch (e) {
        return { ok: false, detail: e.message };
    }
}

/**
 * Adds a to-do task via D-Bus daemon.
 */
async function handleAddTask(action, daemon) {
    if (!action.text)
        return { ok: false, detail: 'task text is required' };
    if (!daemon)
        return { ok: false, detail: 'daemon not connected' };
    try {
        await daemon.call('todo', 'Add', action.text);
        return { ok: true, detail: 'task added' };
    } catch (e) {
        return { ok: false, detail: e.message };
    }
}

/**
 * Marks a to-do task done via D-Bus daemon.
 */
async function handleDoneTask(action, daemon) {
    if (!Number.isInteger(action.id))
        return { ok: false, detail: 'task id is required' };
    if (!daemon)
        return { ok: false, detail: 'daemon not connected' };
    try {
        await daemon.call('todo', 'SetDone', action.id, true);
        return { ok: true, detail: 'task completed' };
    } catch (e) {
        return { ok: false, detail: e.message };
    }
}

/**
 * Removes a to-do task via D-Bus daemon.
 */
async function handleRemoveTask(action, daemon) {
    if (!Number.isInteger(action.id))
        return { ok: false, detail: 'task id is required' };
    if (!daemon)
        return { ok: false, detail: 'daemon not connected' };
    try {
        await daemon.call('todo', 'Remove', action.id);
        return { ok: true, detail: 'task removed' };
    } catch (e) {
        return { ok: false, detail: e.message };
    }
}

/**
 * Sets a reminder via D-Bus daemon.
 */
async function handleRemind(action, daemon) {
    if (!action.text || !(action.minutes > 0))
        return { ok: false, detail: 'a reminder needs its minutes and its words' };
    if (!daemon)
        return { ok: false, detail: 'daemon not connected' };
    try {
        const delayMs = Math.round(action.minutes * 60000);
        await daemon.call('reminders', 'Add', delayMs, action.text);
        return { ok: true, detail: 'reminder set' };
    } catch (e) {
        return { ok: false, detail: e.message };
    }
}

/**
 * Cancels a reminder via D-Bus daemon.
 */
async function handleCancelReminder(action, daemon) {
    if (!Number.isInteger(action.id))
        return { ok: false, detail: 'reminder id is required' };
    if (!daemon)
        return { ok: false, detail: 'daemon not connected' };
    try {
        await daemon.call('reminders', 'Dismiss', action.id);
        return { ok: true, detail: 'reminder cancelled' };
    } catch (e) {
        return { ok: false, detail: e.message };
    }
}

/**
 * Controls system volume via wpctl (PipeWire / WirePlumber).
 */
async function handleVolume(action) {
    let argv;
    if (typeof action.level === 'number') {
        const pct = Math.max(0, Math.min(150, Math.round(action.level)));
        argv = ['wpctl', 'set-volume', '@DEFAULT_AUDIO_SINK@', `${pct}%`];
    } else if (action.command === 'up') {
        argv = ['wpctl', 'set-volume', '@DEFAULT_AUDIO_SINK@', '10%+'];
    } else if (action.command === 'down') {
        argv = ['wpctl', 'set-volume', '@DEFAULT_AUDIO_SINK@', '10%-'];
    } else if (action.command === 'mute') {
        argv = ['wpctl', 'set-mute', '@DEFAULT_AUDIO_SINK@', '1'];
    } else if (action.command === 'unmute') {
        argv = ['wpctl', 'set-mute', '@DEFAULT_AUDIO_SINK@', '0'];
    } else if (action.command === 'toggle') {
        argv = ['wpctl', 'set-mute', '@DEFAULT_AUDIO_SINK@', 'toggle'];
    } else {
        return { ok: false, detail: 'not a volume command' };
    }
    return await runCommand(argv);
}

/**
 * Controls Wi-Fi radio via NetworkManager CLI (nmcli).
 */
async function handleWifi(action) {
    const on = action.on !== false;
    const argv = ['nmcli', 'radio', 'wifi', on ? 'on' : 'off'];
    return await runCommand(argv);
}

/**
 * Controls screen brightness via brightnessctl if available.
 */
async function handleBrightness(action) {
    const program = GLib.find_program_in_path('brightnessctl');
    if (!program)
        return { ok: false, detail: 'brightnessctl is not installed' };
    let argv;
    if (typeof action.level === 'number') {
        const pct = Math.max(1, Math.min(100, Math.round(action.level)));
        argv = [program, 'set', `${pct}%`];
    } else if (action.command === 'up') {
        argv = [program, 'set', '+10%'];
    } else if (action.command === 'down') {
        argv = [program, 'set', '10%-'];
    } else {
        return { ok: false, detail: 'not a brightness command' };
    }
    return await runCommand(argv);
}

/**
 * Prompts user via decide callback and runs the authorized command via systemd-run.
 */
async function handleRun(action, decide) {
    if (typeof decide !== 'function')
        return { ok: false, detail: 'run failed: no decide handler' };

    const answer = await decide(action);
    if (answer === 'unanswered')
        return { ok: false, detail: 'run failed: no answer in time' };
    if (!answer)
        return { ok: false, detail: 'run failed: denied' };
    if (!Array.isArray(action.spawn) || action.spawn.length === 0)
        return { ok: false, detail: 'run failed: no command to spawn' };

    let argv = [...action.spawn];
    if (action.scope === 'system' && argv[0] !== 'pkexec')
        argv = ['pkexec', ...argv];

    return new Promise(resolve => {
        let process;
        try {
            process = Gio.Subprocess.new(argv, Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
        } catch (e) {
            resolve({ ok: false, detail: `run failed: ${e.message}` });
            return;
        }
        process.communicate_utf8_async(null, null, (_proc, res) => {
            try {
                const [, stdout, stderr] = process.communicate_utf8_finish(res);
                const ok = process.get_successful();
                if (ok) {
                    resolve({ ok: true, detail: 'started' });
                } else {
                    const err = (stderr || stdout || 'command failed').trim();
                    resolve({ ok: false, detail: `run failed: ${err}` });
                }
            } catch (e) {
                resolve({ ok: false, detail: `run failed: ${e.message}` });
            }
        });
    });
}

/**
 * Stops a running command unit via systemctl stop (with pkexec for system units).
 * @param {string[]} stopArgv
 * @returns {Promise<{ ok: boolean, detail: string }>}
 */
export function stopUnit(stopArgv) {
    if (!Array.isArray(stopArgv) || stopArgv.length === 0)
        return Promise.resolve({ ok: false, detail: 'invalid stop command' });
    let argv = [...stopArgv];
    const isUser = argv.includes('--user');
    if (!isUser && argv[0] !== 'pkexec')
        argv = ['pkexec', ...argv];
    return runCommand(argv);
}

/**
 * Executes a list of assistant actions sequentially and returns their outcomes.
 * @param {Array<Object>} actions
 * @param {{ daemon?: Object, decide?: Function }} options
 * @returns {Promise<Array<{ type: string, ok: boolean, detail: string }>>}
 */
export async function executeActions(actions, { daemon, decide } = {}) {
    const results = [];
    for (const action of actions ?? []) {
        if (!action || typeof action !== 'object' || !action.type)
            continue;
        let res;
        try {
            switch (action.type) {
            case 'open_url':
                res = handleOpenUrl(action);
                break;
            case 'open_file':
                res = handleOpenFile(action);
                break;
            case 'open_folder':
                res = handleOpenFolder(action);
                break;
            case 'open_app':
                res = handleOpenApp(action);
                break;
            case 'media':
                res = await handleMedia(action, daemon);
                break;
            case 'focus':
                res = await handleFocus(action, daemon);
                break;
            case 'add_task':
                res = await handleAddTask(action, daemon);
                break;
            case 'done_task':
                res = await handleDoneTask(action, daemon);
                break;
            case 'remove_task':
                res = await handleRemoveTask(action, daemon);
                break;
            case 'remind':
                res = await handleRemind(action, daemon);
                break;
            case 'cancel_reminder':
                res = await handleCancelReminder(action, daemon);
                break;
            case 'volume':
                res = await handleVolume(action);
                break;
            case 'wifi':
                res = await handleWifi(action);
                break;
            case 'brightness':
                res = await handleBrightness(action);
                break;
            case 'run':
                res = await handleRun(action, decide);
                break;
            default:
                res = { ok: false, detail: `unknown action: ${action.type}` };
                break;
            }
        } catch (e) {
            res = { ok: false, detail: e.message };
        }
        results.push({
            type: action.type,
            ok: Boolean(res?.ok),
            detail: String(res?.detail ?? ''),
        });
    }
    return results;
}
