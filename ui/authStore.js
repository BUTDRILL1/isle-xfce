// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

//! Secure credential & auth storage manager for Isle XFCE.
//! Stores the NVIDIA NIM API key in ~/.config/isle/nim_api_key (0600) and optional
//! tokens in ~/.config/isle/auth.json (0600). Secrets are never written to settings.json
//! and are never printed or logged.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const VALID_VAULT_ID = /^[a-zA-Z0-9._-]{1,40}$/;

function findProgram(name, homeDir) {
    const onPath = GLib.find_program_in_path(name);
    if (onPath) return onPath;
    const extraDirs = [
        GLib.build_filenamev([homeDir, '.local', 'bin']),
        GLib.build_filenamev([homeDir, '.cargo', 'bin']),
        GLib.build_filenamev([homeDir, '.npm-global', 'bin']),
    ];
    for (const dir of extraDirs) {
        const candidate = GLib.build_filenamev([dir, name]);
        if (GLib.file_test(candidate, GLib.FileTest.IS_EXECUTABLE)) {
            return candidate;
        }
    }
    return null;
}

export class AuthStore {
    constructor({ configDir, homeDir } = {}) {
        this._homeDir = homeDir || GLib.get_home_dir();
        this._configDir = configDir || GLib.build_filenamev([GLib.get_user_config_dir(), 'isle']);
        this._nimKeyPath = GLib.build_filenamev([this._configDir, 'nim_api_key']);
        this._vaultPath = GLib.build_filenamev([this._configDir, 'auth.json']);
    }

    get configDir() {
        return this._configDir;
    }

    get nimKeyPath() {
        return this._nimKeyPath;
    }

    get vaultPath() {
        return this._vaultPath;
    }

    _maskSecret(raw) {
        const s = typeof raw === 'string' ? raw.trim() : '';
        if (!s) return '';
        if (s.length <= 10) return '••••••••';
        return `${s.slice(0, 6)}••••${s.slice(-4)}`;
    }

    _writePrivateFile(path, text) {
        const parent = GLib.path_get_dirname(path);
        GLib.mkdir_with_parents(parent, 0o700);
        const f = Gio.File.new_for_path(path);
        const bytes = new TextEncoder().encode(text);
        f.replace_contents(
            bytes,
            null,
            false,
            Gio.FileCreateFlags.PRIVATE | Gio.FileCreateFlags.REPLACE_DESTINATION,
            null
        );
        try {
            f.set_attribute_uint32('unix::mode', 0o600, Gio.FileQueryInfoFlags.NONE, null);
        } catch (e) {
            print('[Isle AuthStore] Could not enforce 0600 permissions:', e.message);
        }
    }

    _readFileTrimmed(path) {
        try {
            const f = Gio.File.new_for_path(path);
            if (!f.query_exists(null)) return '';
            const [ok, contents] = f.load_contents(null);
            if (!ok) return '';
            return new TextDecoder().decode(contents).trim();
        } catch (_) {
            return '';
        }
    }

    hasNimKey() {
        return this.getNimKeyStatus().configured;
    }

    getNimKeyStatus() {
        const fileKey = this._readFileTrimmed(this._nimKeyPath);
        if (fileKey) {
            return {
                configured: true,
                source: 'file',
                hint: this._maskSecret(fileKey),
            };
        }
        const envKey = (GLib.getenv('NVIDIA_API_KEY') || GLib.getenv('NIM_API_KEY') || '').trim();
        if (envKey) {
            return {
                configured: true,
                source: 'env',
                hint: this._maskSecret(envKey),
            };
        }
        return {
            configured: false,
            source: 'none',
            hint: '',
        };
    }

    setNimKey(raw) {
        const trimmed = typeof raw === 'string' ? raw.trim() : '';
        if (!trimmed) {
            this.clearNimKey();
            return true;
        }
        try {
            this._writePrivateFile(this._nimKeyPath, trimmed);
            return true;
        } catch (e) {
            print('[Isle AuthStore] Failed to save NIM key:', e.message);
            return false;
        }
    }

    clearNimKey() {
        try {
            const f = Gio.File.new_for_path(this._nimKeyPath);
            if (f.query_exists(null)) {
                f.delete(null);
            }
            return true;
        } catch (e) {
            print('[Isle AuthStore] Failed to clear NIM key:', e.message);
            return false;
        }
    }

    _readVault() {
        try {
            const f = Gio.File.new_for_path(this._vaultPath);
            if (!f.query_exists(null)) return {};
            const [ok, contents] = f.load_contents(null);
            if (!ok) return {};
            const parsed = JSON.parse(new TextDecoder().decode(contents));
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
            const out = {};
            for (const [k, v] of Object.entries(parsed)) {
                if (VALID_VAULT_ID.test(k) && typeof v === 'string' && v.trim()) {
                    out[k] = v.trim();
                }
            }
            return out;
        } catch (_) {
            return {};
        }
    }

    _writeVault(vault) {
        const keys = Object.keys(vault).sort();
        if (keys.length === 0) {
            try {
                const f = Gio.File.new_for_path(this._vaultPath);
                if (f.query_exists(null)) f.delete(null);
                return true;
            } catch (e) {
                print('[Isle AuthStore] Failed to remove empty vault:', e.message);
                return false;
            }
        }
        const sorted = {};
        for (const k of keys) sorted[k] = vault[k];
        this._writePrivateFile(this._vaultPath, JSON.stringify(sorted, null, 2));
        return true;
    }

    listVaultEntries() {
        const vault = this._readVault();
        return Object.keys(vault)
            .sort()
            .map(id => ({
                id,
                hint: this._maskSecret(vault[id]),
            }));
    }

    setVaultEntry(id, secret) {
        const cleanId = typeof id === 'string' ? id.trim() : '';
        const cleanSecret = typeof secret === 'string' ? secret.trim() : '';
        if (!VALID_VAULT_ID.test(cleanId) || !cleanSecret) {
            return false;
        }
        try {
            const vault = this._readVault();
            vault[cleanId] = cleanSecret;
            return this._writeVault(vault);
        } catch (e) {
            print('[Isle AuthStore] Failed to save vault entry:', e.message);
            return false;
        }
    }

    deleteVaultEntry(id) {
        const cleanId = typeof id === 'string' ? id.trim() : '';
        if (!cleanId) return false;
        try {
            const vault = this._readVault();
            if (!(cleanId in vault)) return true;
            delete vault[cleanId];
            return this._writeVault(vault);
        } catch (e) {
            print('[Isle AuthStore] Failed to delete vault entry:', e.message);
            return false;
        }
    }

    getProviderStatuses() {
        const home = this._homeDir;
        const claudeDir = GLib.getenv('CLAUDE_CONFIG_DIR') || GLib.build_filenamev([home, '.claude']);
        const codexDir = GLib.getenv('CODEX_HOME') || GLib.build_filenamev([home, '.codex']);
        const grokDir = GLib.getenv('GROK_HOME') || GLib.build_filenamev([home, '.grok']);
        const dataDir = GLib.get_user_data_dir() || GLib.build_filenamev([home, '.local', 'share']);

        const claudeEnv = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX']
            .some(n => Boolean((GLib.getenv(n) || '').trim()));
        const codexEnv = Boolean((GLib.getenv('OPENAI_API_KEY') || '').trim());

        const claudeConfigured = GLib.file_test(GLib.build_filenamev([claudeDir, '.credentials.json']), GLib.FileTest.EXISTS) || claudeEnv;
        const codexConfigured = GLib.file_test(GLib.build_filenamev([codexDir, 'auth.json']), GLib.FileTest.EXISTS) || codexEnv;
        const grokConfigured = GLib.file_test(GLib.build_filenamev([grokDir, 'auth.json']), GLib.FileTest.EXISTS);
        const opencodeConfigured = GLib.file_test(GLib.build_filenamev([dataDir, 'opencode', 'auth.json']), GLib.FileTest.EXISTS);
        const agyConfigured = GLib.file_test(GLib.build_filenamev([home, '.gemini', 'antigravity-cli', 'antigravity-oauth-token']), GLib.FileTest.EXISTS)
            || GLib.file_test(GLib.build_filenamev([home, '.gemini', 'jetski-standalone-oauth-token']), GLib.FileTest.EXISTS);

        return [
            {
                id: 'nim',
                name: 'NVIDIA NIM',
                configured: this.hasNimKey(),
                cliFound: true,
                signInCmd: null,
            },
            {
                id: 'claude',
                name: 'Claude Code',
                configured: claudeConfigured,
                cliFound: Boolean(findProgram('claude', home)),
                signInCmd: 'claude',
            },
            {
                id: 'codex',
                name: 'Codex',
                configured: codexConfigured,
                cliFound: Boolean(findProgram('codex', home)),
                signInCmd: 'codex login',
            },
            {
                id: 'grok',
                name: 'Grok',
                configured: grokConfigured,
                cliFound: Boolean(findProgram('grok', home)),
                signInCmd: 'grok login',
            },
            {
                id: 'opencode',
                name: 'opencode',
                configured: opencodeConfigured,
                cliFound: Boolean(findProgram('opencode', home)),
                signInCmd: 'opencode auth login',
            },
            {
                id: 'agy',
                name: 'Antigravity',
                configured: agyConfigured,
                cliFound: Boolean(findProgram('agy', home)),
                signInCmd: 'agy',
            },
            {
                id: 'butler',
                name: 'BUTLER',
                configured: this.hasNimKey() || this.listVaultEntries().some(e => /(gemini|google|claude|anthropic|nvidia|nim)/i.test(e.id)) || GLib.file_test(GLib.build_filenamev([home, 'Desktop', 'BUTLER', '.env']), GLib.FileTest.EXISTS),
                cliFound: Boolean(findProgram('python3', home)) && GLib.file_test(GLib.build_filenamev([home, 'Desktop', 'BUTLER', 'src']), GLib.FileTest.IS_DIR),
                signInCmd: null,
            },
        ];
    }

    launchSignIn(providerId) {
        const info = this.getProviderStatuses().find(p => p.id === providerId);
        if (!info || !info.signInCmd) return false;
        try {
            if (GLib.find_program_in_path('xfce4-terminal')) {
                Gio.Subprocess.new(
                    ['xfce4-terminal', '--hold', '-e', info.signInCmd],
                    Gio.SubprocessFlags.NONE
                );
                return true;
            }
            if (GLib.find_program_in_path('x-terminal-emulator')) {
                Gio.Subprocess.new(
                    ['x-terminal-emulator', '-e', info.signInCmd],
                    Gio.SubprocessFlags.NONE
                );
                return true;
            }
        } catch (e) {
            print('[Isle AuthStore] Could not open terminal for sign-in:', e.message);
        }
        return false;
    }
}

let _instance = null;
export function getAuthStore() {
    if (!_instance) {
        _instance = new AuthStore();
    }
    return _instance;
}
