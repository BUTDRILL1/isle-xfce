// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

// Client for isled, the Rust service that does the actual work.
// Ported for Isle XFCE GTK4 runtime.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

export class EventEmitter {
    constructor() {
        this._listeners = new Map();
        this._nextId = 1;
    }

    connect(signal, callback) {
        if (!this._listeners.has(signal))
            this._listeners.set(signal, new Map());
        const id = this._nextId++;
        this._listeners.get(signal).set(id, callback);
        return id;
    }

    disconnect(id) {
        for (const map of this._listeners.values()) {
            if (map.delete(id))
                return;
        }
    }

    disconnectAll() {
        this._listeners.clear();
    }

    emit(signal, ...args) {
        const map = this._listeners.get(signal);
        if (!map)
            return;
        for (const cb of [...map.values()]) {
            try {
                cb(this, ...args);
            } catch (e) {
                console.error(`Error in event listener for ${signal}:`, e);
            }
        }
    }
}

const BUS_NAME = 'io.github.zickrian.isle.Daemon';
const OBJECT_PATH = '/io/github/zickrian/isle/Daemon';

const node = (name, body) =>
    `<node><interface name="io.github.zickrian.isle.${name}">${body}</interface></node>`;

const INTERFACES = {
    media: {
        xml: node('Media1', `
            <method name="PlayPause"/>
            <method name="Next"/>
            <method name="Previous"/>
            <method name="SetPosition"><arg name="position_us" type="x" direction="in"/></method>
            <method name="Raise"/>
            <method name="Choose"><arg name="name" type="s" direction="in"/></method>
            <method name="Dismiss"/>
            <method name="SetLyrics"><arg name="enabled" type="b" direction="in"/></method>
            <method name="SetWatching"><arg name="watching" type="b" direction="in"/></method>
            <property name="NowPlaying" type="s" access="read"/>
            <property name="Lyrics" type="s" access="read"/>
            <property name="Players" type="s" access="read"/>`),
        properties: { NowPlaying: 'nowPlaying', Lyrics: 'lyrics', Players: 'players' },
    },
    pomodoro: {
        xml: node('Pomodoro1', `
            <method name="Start"/>
            <method name="Pause"/>
            <method name="Stop"/>
            <method name="Skip"/>
            <method name="StartPhase"><arg name="phase" type="s" direction="in"/></method>
            <method name="SetConfig"><arg name="config" type="s" direction="in"/></method>
            <signal name="PhaseFinished"><arg name="finished" type="s"/><arg name="next" type="s"/></signal>
            <property name="State" type="s" access="read"/>
            <property name="Config" type="s" access="read"/>`),
        properties: { State: 'pomodoro', Config: 'pomodoroConfig' },
    },
    system: {
        xml: node('System1', `
            <signal name="Event"><arg name="event" type="s"/></signal>
            <property name="State" type="s" access="read"/>`),
        properties: { State: 'system' },
    },
    usage: {
        xml: node('Usage1', `
            <method name="SetConfig"><arg name="config" type="s" direction="in"/></method>
            <method name="Refresh"/>
            <signal name="Alert"><arg name="provider" type="s"/><arg name="window" type="s"/><arg name="percent" type="d"/><arg name="resets_at_ms" type="x"/></signal>
            <property name="Usage" type="s" access="read"/>`),
        properties: { Usage: 'usage' },
    },
    todo: {
        xml: node('Todo1', `
            <method name="Add"><arg name="text" type="s" direction="in"/><arg type="t" direction="out"/></method>
            <method name="SetDone"><arg name="id" type="t" direction="in"/><arg name="done" type="b" direction="in"/></method>
            <method name="Rename"><arg name="id" type="t" direction="in"/><arg name="title" type="s" direction="in"/></method>
            <method name="Remove"><arg name="id" type="t" direction="in"/></method>
            <method name="ClearDone"/>
            <property name="Items" type="s" access="read"/>`),
        properties: { Items: 'tasks' },
    },
    shelf: {
        xml: node('Shelf1', `
            <method name="Add"><arg name="uris" type="as" direction="in"/></method>
            <method name="Remove"><arg name="uri" type="s" direction="in"/></method>
            <method name="Clear"/>
            <method name="Refresh"/>
            <property name="Items" type="s" access="read"/>`),
        properties: { Items: 'shelf' },
    },
    share: {
        xml: node('Share1', `
            <method name="Start"/>
            <method name="Stop"/>
            <method name="Answer"><arg name="id" type="s" direction="in"/><arg name="allow" type="b" direction="in"/></method>
            <method name="Remove"><arg name="id" type="s" direction="in"/></method>
            <method name="Code"><arg type="s" direction="out"/></method>
            <signal name="Received"><arg name="name" type="s"/></signal>
            <property name="State" type="s" access="read"/>`),
        properties: { State: 'share' },
    },
    clipboard: {
        xml: node('Clipboard1', `
            <method name="AddText"><arg name="text" type="s" direction="in"/><arg name="app_id" type="s" direction="in"/><arg type="t" direction="out"/></method>
            <method name="AddImage"><arg name="png" type="ay" direction="in"/><arg name="app_id" type="s" direction="in"/><arg type="t" direction="out"/></method>
            <method name="AddFiles"><arg name="uris" type="as" direction="in"/><arg name="app_id" type="s" direction="in"/><arg type="t" direction="out"/></method>
            <method name="GetText"><arg name="id" type="t" direction="in"/><arg type="s" direction="out"/></method>
            <method name="Search"><arg name="query" type="s" direction="in"/><arg type="at" direction="out"/></method>
            <method name="Touch"><arg name="id" type="t" direction="in"/></method>
            <method name="SetPinned"><arg name="id" type="t" direction="in"/><arg name="pinned" type="b" direction="in"/></method>
            <method name="Remove"><arg name="id" type="t" direction="in"/></method>
            <method name="Clear"/>
            <property name="Items" type="s" access="read"/>`),
        properties: { Items: 'clipboard' },
    },
    calendar: {
        xml: node('Calendar1', `
            <method name="Add"><arg name="date" type="s" direction="in"/><arg name="text" type="s" direction="in"/><arg type="t" direction="out"/></method>
            <method name="AddTo"><arg name="calendar" type="s" direction="in"/><arg name="date" type="s" direction="in"/><arg name="text" type="s" direction="in"/><arg type="s" direction="out"/></method>
            <method name="Calendars"><arg type="s" direction="out"/></method>
            <method name="Colors"><arg type="s" direction="out"/></method>
            <method name="Parse"><arg name="text" type="s" direction="in"/><arg type="s" direction="out"/></method>
            <method name="Remove"><arg name="id" type="t" direction="in"/></method>
            <method name="SetDesktopEvents"><arg name="events_json" type="s" direction="in"/></method>
            <method name="MeetingLink"><arg name="source_uid" type="s" direction="in"/><arg name="event_uid" type="s" direction="in"/><arg type="s" direction="out"/></method>
            <property name="Events" type="s" access="read"/>`),
        properties: { Events: 'events' },
    },
    reminders: {
        xml: node('Reminders1', `
            <method name="Add"><arg name="delay_ms" type="t" direction="in"/><arg name="text" type="s" direction="in"/><arg type="t" direction="out"/></method>
            <method name="Dismiss"><arg name="id" type="t" direction="in"/></method>
            <property name="Items" type="s" access="read"/>`),
        properties: { Items: 'reminders' },
    },
    appUsage: {
        xml: node('AppUsage1', `
            <method name="Report">
                <arg name="stretches" type="a(ssxx)" direction="in"/>
            </method>
            <method name="GetStats"><arg name="stats" type="s" direction="out"/></method>
            <method name="Clear"/>`),
        properties: {},
    },
    updates: {
        xml: node('Updates1', `
            <method name="SetEnabled"><arg name="enabled" type="b" direction="in"/></method>
            <property name="Latest" type="s" access="read"/>`),
        properties: { Latest: 'updates' },
    },
    agents: {
        xml: node('Agents1', `
            <method name="SetHooked"><arg name="provider" type="s" direction="in"/><arg name="on" type="b" direction="in"/></method>
            <method name="Resolve"><arg name="id" type="s" direction="in"/><arg name="decision" type="s" direction="in"/></method>
            <method name="SetPresent"><arg name="present" type="b" direction="in"/></method>
            <signal name="Event"><arg name="event" type="s"/></signal>
            <signal name="Asking"><arg name="request" type="s"/></signal>
            <signal name="Withdrawn"><arg name="id" type="s"/></signal>
            <property name="Agents" type="s" access="read"/>`),
        properties: { Agents: 'agents' },
    },
    assistant: {
        xml: node('Assistant1', `
            <method name="Warm"><arg name="context" type="s" direction="in"/></method>
            <method name="Listen"><arg name="context" type="s" direction="in"/></method>
            <method name="Ask"><arg name="text" type="s" direction="in"/><arg name="context" type="s" direction="in"/></method>
            <method name="Stop"/>
            <method name="End"/>
            <method name="Results"><arg name="step" type="t" direction="in"/><arg name="results" type="s" direction="in"/></method>
            <method name="Cancel"/>
            <method name="NewChat"/>
            <method name="UndoNewChat"/>
            <method name="ClearChat"/>
            <method name="Speaking"><arg type="b" direction="out"/></method>
            <method name="SetWhistleWake"><arg name="enabled" type="b" direction="in"/></method>
            <signal name="Level"><arg name="level" type="d"/></signal>
            <signal name="Wake"/>
            <signal name="Notice"><arg name="text" type="s"/><arg name="ok" type="b"/></signal>
            <signal name="ModelSwitched"><arg name="provider" type="s"/><arg name="plan" type="s"/><arg name="picked" type="s"/><arg name="used" type="s"/></signal>
            <property name="State" type="s" access="read"/>
            <property name="History" type="s" access="read"/>`),
        properties: { State: 'assistant', History: 'chat' },
    },
};

const PLAIN = new Set(['updates']);

export class Daemon extends EventEmitter {
    constructor() {
        super();
        this.state = {};
        this._raw = {};
        this._proxies = {};
        this._inFlight = new Map();
        this._cancellable = new Gio.Cancellable();

        for (const [name, { xml, properties }] of Object.entries(INTERFACES)) {
            for (const key of Object.values(properties))
                this.state[key] = null;
            this._connect(name, xml, properties);
        }

        this.running = false;
        this._nameWatch = Gio.bus_watch_name(
            Gio.BusType.SESSION,
            BUS_NAME,
            Gio.BusNameWatcherFlags.NONE,
            () => this._setRunning(true),
            () => this._setRunning(false)
        );
        this.start();
    }

    _setRunning(running) {
        if (running === this.running)
            return;
        this.running = running;
        this.emit('running-changed');
    }

    start() {
        Gio.DBus.session.call(
            'org.freedesktop.DBus',
            '/org/freedesktop/DBus',
            'org.freedesktop.DBus',
            'StartServiceByName',
            new GLib.Variant('(su)', [BUS_NAME, 0]),
            null,
            Gio.DBusCallFlags.NONE,
            -1,
            this._cancellable,
            (connection, result) => {
                try {
                    connection.call_finish(result);
                } catch (e) {
                    if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) {
                        // isled might already be running
                    }
                }
            }
        );
    }

    _connect(name, xml, properties) {
        const DaemonProxy = Gio.DBusProxy.makeProxyWrapper(xml);
        new DaemonProxy(Gio.DBus.session, BUS_NAME, OBJECT_PATH, (proxy, error) => {
            if (error) {
                if (!error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                    console.warn(`Isle: could not create the ${name} proxy: ${error.message}`);
                return;
            }
            this._proxies[name] = proxy;

            const refresh = () => {
                for (const [property, key] of Object.entries(properties))
                    this._update(key, proxy[property]);
            };

            proxy.connect('g-properties-changed', (_proxy, changed, invalidated) => {
                for (const property of [...Object.keys(changed.unpack()), ...invalidated]) {
                    if (property in properties)
                        this._update(properties[property], proxy[property]);
                }
            });

            proxy.connect('notify::g-name-owner', refresh);
            proxy.connect('notify::g-name-owner', () => {
                if (proxy.g_name_owner)
                    this.emit('appeared', name);
            });
            if (name === 'assistant') {
                let owner = proxy.g_name_owner;
                proxy.connect('notify::g-name-owner', () => {
                    const was = owner;
                    owner = proxy.g_name_owner;
                    if (was && was !== owner)
                        this.emit('assistant-lost');
                });
            }

            proxy.connect('g-signal', (_proxy, _sender, signal, parameters) =>
                this._onSignal(name, signal, parameters.deep_unpack()));

            refresh();
            if (proxy.g_name_owner)
                this.emit('appeared', name);
        }, this._cancellable, Gio.DBusProxyFlags.DO_NOT_AUTO_START_AT_CONSTRUCTION);
    }

    hold() {
        this._held ??= [];
    }

    release() {
        const held = this._held ?? [];
        this._held = null;
        for (const args of held)
            this.emit(...args);
    }

    emit(...args) {
        if (!this._held)
            return super.emit(...args);
        if (args[0] !== 'changed' || !this._held.some(([name, key]) => name === 'changed' && key === args[1]))
            this._held.push(args);
        return undefined;
    }

    _update(key, json) {
        if (key in this._raw && this._raw[key] === json)
            return;
        this._raw[key] = json;
        let value = null;
        try {
            value = !json ? null : PLAIN.has(key) ? json : JSON.parse(json);
        } catch (e) {
            console.warn(`Isle: invalid ${key} from isled: ${e.message}`);
        }
        this.state[key] = value;
        this.emit('changed', key);
    }

    _onSignal(name, signal, args) {
        switch (signal) {
        case 'PhaseFinished':
            this.emit('pomodoro-finished', ...args);
            break;
        case 'Alert':
            this.emit('usage-alert', ...args);
            break;
        case 'Level':
            this.emit('assistant-level', ...args);
            this.emit('voice-level', ...args);
            break;
        case 'Wake':
            this.emit('assistant-wake');
            break;
        case 'Notice':
            this.emit('assistant-notice', ...args);
            break;
        case 'ModelSwitched':
            this.emit('assistant-model-switched', ...args);
            this.emit('model-switched', ...args);
            break;
        case 'Withdrawn':
            this.emit('agent-withdrawn', args[0]);
            break;
        case 'Asking':
            try {
                this.emit('agent-asking', JSON.parse(args[0]));
            } catch (e) {
                console.warn(`Isle: invalid permission request: ${e.message}`);
            }
            break;
        case 'Received':
            this.emit('phone-received', args[0]);
            break;
        case 'Event':
            try {
                this.emit(name === 'agents' ? 'agent-event' : 'system-event', JSON.parse(args[0]));
            } catch (e) {
                console.warn(`Isle: invalid ${name} event: ${e.message}`);
            }
            break;
        }
    }

    call(name, method, ...args) {
        return this.attempt(name, method, ...args).then(({ result }) => result);
    }

    async addEvent(calendar, date, text) {
        const { result, unknownMethod } = await this.attempt('calendar', 'AddTo', calendar, date, text);
        if (!unknownMethod)
            return result;
        return await this.call('calendar', 'Add', date, text) ? [''] : null;
    }

    attempt(name, method, ...args) {
        return this._attempt(name, method, args, false);
    }

    attemptQuietly(name, method, ...args) {
        return this._attempt(name, method, args, true);
    }

    _attempt(name, method, args, quiet) {
        const proxy = this._proxies[name];
        if (!proxy) {
            print(`[Isle daemon _attempt] ERROR: No proxy found for ${name}`);
            return Promise.resolve({ result: null, error: null });
        }
        print(`[Isle daemon _attempt] Calling ${name}.${method} with ${args.length} args:`, JSON.stringify(args));
        return new Promise(resolve => {
            try {
                proxy[`${method}Remote`](...args, (result, error) => {
                    this._settle(proxy);
                    if (this._destroyed) {
                        resolve({ result: null, error: null });
                        return;
                    }
                    if (error) {
                        print(`[Isle daemon _attempt] ${name}.${method} FAILED: ${error.message}`);
                    } else {
                        print(`[Isle daemon _attempt] ${name}.${method} SUCCEEDED`);
                    }
                    if (error && !quiet)
                        console.warn(`Isle: ${method} failed: ${error.message}`);
                    const remoteName = error ? Gio.DBusError.get_remote_error(error) : null;
                    const refused = ['org.freedesktop.DBus.Error.Failed', 'org.freedesktop.DBus.Error.InvalidArgs'].includes(remoteName);
                    resolve({
                        result: error ? null : result,
                        error: refused ? error.message.replace(/^GDBus\.Error:[\w.]+:\s*/, '') : null,
                        unknownMethod: remoteName === 'org.freedesktop.DBus.Error.UnknownMethod',
                    });
                });
                this._inFlight.set(proxy, (this._inFlight.get(proxy) ?? 0) + 1);
            } catch (e) {
                console.warn(`Isle: ${method} failed: ${e.message}`);
                resolve({ result: null, error: null });
            }
        });
    }

    _settle(proxy) {
        const left = (this._inFlight.get(proxy) ?? 1) - 1;
        if (left > 0) {
            this._inFlight.set(proxy, left);
            return;
        }
        this._inFlight.delete(proxy);
        if (this._destroyed)
            proxy.run_dispose();
    }

    destroy() {
        this._destroyed = true;
        this.disconnectAll();
        this._cancellable.cancel();
        Gio.bus_unwatch_name(this._nameWatch);
        for (const proxy of Object.values(this._proxies)) {
            if (!this._inFlight.has(proxy))
                proxy.run_dispose();
        }
        this._proxies = {};
    }
}

