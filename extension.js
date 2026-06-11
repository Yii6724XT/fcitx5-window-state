import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';

import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

// ---------------------------------------------------------------------------
// Fcitx5 D-Bus interface (verified on this machine 2026-06-10)
//
// Service:  org.fcitx.Fcitx5
// Path:     /controller
// Interface: org.fcitx.Fcitx.Controller1
//
// The Controller1 interface exposes CurrentInputMethod() and SetCurrentIM(),
// but has NO signal for IM changes — only InputMethodGroupsChanged (groups,
// not individual IMs).  We therefore poll CurrentInputMethod() on a timer.
// ---------------------------------------------------------------------------
const FCITX5_SERVICE = 'org.fcitx.Fcitx5';
const FCITX5_PATH    = '/controller';

const Controller1Xml = `
<node>
  <interface name="org.fcitx.Fcitx.Controller1">
    <method name="CurrentInputMethod">
      <arg direction="out" type="s" name="im_name"/>
    </method>
    <method name="SetCurrentIM">
      <arg direction="in" type="s" name="im_name"/>
    </method>
  </interface>
</node>`;

const ControllerProxy = Gio.DBusProxy.makeProxyWrapper(Controller1Xml);

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const LAUNCHER_BLACKLIST = ['ulauncher', 'albert', 'rofi'];
const DEFAULT_IM         = 'keyboard-us'; // US English, verified on this host
const POLL_INTERVAL_MS   = 200;           // CurrentInputMethod poll interval
const DEBOUNCE_MS        = 80;            // consolidate rapid focus changes
const DEBUG              = false;          // set to false to silence all debug logs

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------
let _seq = 0; // monotonic log sequence number

export default class Fcitx5WindowStateExtension extends Extension {
    _dbg(msg) {
        if (!DEBUG) return;
        log(`[fcitx5-ws] #${++_seq} ${msg}`);
    }
    enable() {
        this._stateMap              = new Map();  // window_id (number) -> im_name (string)
        this._proxy                 = null;
        this._pendingIm             = null;
        this._lastKnownIM           = null;
        this._inProgrammaticSwitch  = false;
        this._pollInFlight          = false;
        this._debounceSource        = 0;
        this._pollSource            = 0;
        this._nameWatcherId         = 0;
        this._signalIds             = [];         // global.display signal handler IDs
        this._overviewWindowId      = null;

        // Map: MetaWindow -> [signal handler IDs on that window]
        this._windowSignalMap = new Map();

        this._dbg('ENABLE');
        this._init();
    }

    disable() {
        // 1. Display signals
        for (const id of this._signalIds)
            global.display.disconnect(id);
        this._signalIds = [];

        // 2. Overview signals
        if (this._overviewShowingId) {
            Main.overview.disconnect(this._overviewShowingId);
            this._overviewShowingId = null;
        }
        if (this._overviewHidingId) {
            Main.overview.disconnect(this._overviewHidingId);
            this._overviewHidingId = null;
        }

        // 3. Per-window unmanaged signals
        for (const [win, ids] of this._windowSignalMap) {
            for (const sid of ids) {
                try { win.disconnect(sid); } catch (_) { /* already gone */ }
            }
        }
        this._windowSignalMap.clear();

        // 4. Timers
        if (this._debounceSource) {
            GLib.source_remove(this._debounceSource);
            this._debounceSource = 0;
        }
        if (this._pollSource) {
            GLib.source_remove(this._pollSource);
            this._pollSource = 0;
        }

        // 5. D-Bus name watcher
        if (this._nameWatcherId) {
            Gio.bus_unwatch_name(this._nameWatcherId);
            this._nameWatcherId = 0;
        }

        // 6. Release all JS-land references
        this._dbg('DISABLE');
        this._stateMap.clear();
        this._stateMap              = null;
        this._proxy                 = null;
        this._windowSignalMap       = null;
    }

    // ======================================================================
    //  Initialisation
    //
    //  We do NOT create the D-Bus proxy synchronously here — that would
    //  block GNOME Shell's main thread while D-Bus tries to auto-start
    //  Fcitx5 (which typically isn't running yet at login time).
    //  Instead we watch for the Fcitx5 bus name to appear asynchronously.
    // ======================================================================
    _init() {
        try {
            // Watch Fcitx5 service availability without blocking
            this._nameWatcherId = Gio.bus_watch_name(
                Gio.BusType.SESSION,
                FCITX5_SERVICE,
                Gio.BusNameWatcherFlags.NONE,
                (_c, _n, _o) => this._onFcitx5Appeared(),
                (_c, _n) => this._onFcitx5Vanished()
            );
            this._dbg('name watcher started');

            // Core hook: window focus changes
            this._signalIds.push(
                global.display.connect(
                    'notify::focus-window',
                    () => this._onFocusWindowChanged()
                )
            );
            this._dbg('focus-window signal connected');

            // GNOME Overview integration
            this._overviewShowingId = Main.overview.connect(
                'showing',
                () => this._onOverviewShowing()
            );
            this._overviewHidingId = Main.overview.connect(
                'hiding',
                () => this._onOverviewHiding()
            );
            this._dbg('overview signals connected');

        } catch (e) {
            log(`[fcitx5-window-state] Init failed: ${e.message}`);
        }
    }

    // Called asynchronously when Fcitx5's D-Bus name appears on the bus.
    // This may happen well after GNOME Shell has finished starting.
    _onFcitx5Appeared() {
        this._dbg('Fcitx5 service appeared — initializing proxy');

        try {
            // Now that Fcitx5 is running, creating the proxy is fast & safe
            this._proxy = new ControllerProxy(
                Gio.DBus.session,
                FCITX5_SERVICE,
                FCITX5_PATH
            );
            this._dbg('proxy created');

            // Seed _lastKnownIM so the first poll doesn't trigger a false change
            this._lastKnownIM = DEFAULT_IM;
            this._proxy.CurrentInputMethodRemote((result, error) => {
                if (!error) {
                    this._lastKnownIM = String(result);
                    this._dbg(`seed lastKnownIM="${this._lastKnownIM}"`);
                } else {
                    this._dbg(`seed failed: ${error.message}, using "${DEFAULT_IM}"`);
                }
            });

            // Apply cached IM for the currently focused window (if any)
            const win = global.display.focus_window;
            if (win &&
                win.get_window_type() === Meta.WindowType.NORMAL &&
                this._stateMap.has(win.get_id())) {
                const cached = this._stateMap.get(win.get_id());
                this._dbg(`applying cached IM "${cached}" for focused win=${win.get_id()}`);
                this._setCurrentIM(cached);
            }

            // Start periodic polling
            if (!this._pollSource) {
                this._pollSource = GLib.timeout_add(
                    GLib.PRIORITY_DEFAULT,
                    POLL_INTERVAL_MS,
                    () => {
                        this._pollCurrentIM();
                        return GLib.SOURCE_CONTINUE;
                    }
                );
                this._dbg('poll timer started');
            }

        } catch (e) {
            log(`[fcitx5-window-state] Fcitx5 appeared init failed: ${e.message}`);
        }
    }

    // Called when Fcitx5's D-Bus name disappears (e.g. service restart).
    _onFcitx5Vanished() {
        this._dbg('Fcitx5 service vanished — cleaning up proxy');

        if (this._pollSource) {
            GLib.source_remove(this._pollSource);
            this._pollSource = 0;
        }
        if (this._debounceSource) {
            GLib.source_remove(this._debounceSource);
            this._debounceSource = 0;
        }

        this._proxy = null;
        this._pollInFlight = false;
        this._pendingIm = null;
        this._inProgrammaticSwitch = false;
    }

    // ======================================================================
    //  Feature B: Polling-based State Tracking
    //  Periodically diffs CurrentInputMethod() against _lastKnownIM.  When
    //  the value changes and we didn't initiate it, we record the new IM
    //  for the currently focused window.
    // ======================================================================
    _pollCurrentIM() {
        if (!this._proxy || this._pollInFlight)
            return;

        this._pollInFlight = true;
        this._proxy.CurrentInputMethodRemote((result, error) => {
            this._pollInFlight = false;
            if (error) {
                this._dbg(`poll CurrentInputMethod ERROR: ${error.message}`);
                return;
            }

            const current = String(result);

            if (current === this._lastKnownIM)
                return; // no change

            this._dbg(`poll DETECTED change: "${this._lastKnownIM}" -> "${current}"${this._inProgrammaticSwitch ? ' (IGNORED: inProgrammaticSwitch)' : ''}`);

            this._lastKnownIM = current;

            // Ignore changes that we ourselves triggered via SetCurrentIM()
            if (this._inProgrammaticSwitch)
                return;

            // Feature B: Persist the new IM for the focused window
            const win = global.display.focus_window;
            if (!win || win.get_window_type() !== Meta.WindowType.NORMAL) {
                this._dbg(`poll save SKIP: no focused NORMAL window (type=${win ? win.get_window_type() : 'null'})`);
                return;
            }

            const wmClass = (win.get_wm_class() || '').toLowerCase();
            if (this._isLauncher(wmClass)) {
                this._dbg(`poll save SKIP: launcher (wmClass="${wmClass}")`);
                return;
            }

            const prev = this._stateMap.get(win.get_id());
            this._stateMap.set(win.get_id(), current);
            this._dbg(`poll SAVED win=${win.get_id()} wmClass="${wmClass}" "${prev}" -> "${current}" (stateMap.size=${this._stateMap.size})`);
        });
    }

    // ======================================================================
    //  Feature A: Normal Window State Memory & Recovery
    // ======================================================================
    _onFocusWindowChanged() {
        const win = global.display.focus_window;
        if (!win) {
            this._dbg('FOCUS: null');
            return;
        }
        if (win.get_window_type() !== Meta.WindowType.NORMAL) {
            this._dbg(`FOCUS: non-NORMAL type=${win.get_window_type()}`);
            return;
        }

        const winId   = win.get_id();
        const wmClass = (win.get_wm_class() || '').toLowerCase();
        const cached  = this._stateMap.has(winId) ? this._stateMap.get(winId) : null;

        // Feature C: Launcher apps — force English, do NOT save state
        if (this._isLauncher(wmClass)) {
            this._dbg(`FOCUS: win=${winId} wmClass="${wmClass}" LAUNCHER -> force "${DEFAULT_IM}"`);
            this._setCurrentIM(DEFAULT_IM);
            return;
        }

        // Feature D: Transient / dialog window inheritance
        const parent = win.get_transient_for();
        if (parent && this._stateMap.has(parent.get_id())) {
            const parentIM = this._stateMap.get(parent.get_id());
            this._dbg(`FOCUS: win=${winId} wmClass="${wmClass}" TRANSIENT of ${parent.get_id()} inherit "${parentIM}"`);
            this._stateMap.set(winId, parentIM);
            this._setCurrentIM(parentIM);
            this._trackWindow(win);
            return;
        }

        // Feature A: Restore cached IM or default to English
        if (this._stateMap.has(winId)) {
            this._dbg(`FOCUS: win=${winId} wmClass="${wmClass}" RESTORE cached="${cached}" (stateMap.size=${this._stateMap.size})`);
            this._setCurrentIM(this._stateMap.get(winId));
        } else {
            this._dbg(`FOCUS: win=${winId} wmClass="${wmClass}" NEW -> init to "${DEFAULT_IM}" (stateMap.size=${this._stateMap.size})`);
            this._stateMap.set(winId, DEFAULT_IM);
            this._setCurrentIM(DEFAULT_IM);
        }

        this._trackWindow(win);
    }

    // ======================================================================
    //  Feature C: GNOME Overview & Third-party Launchers
    // ======================================================================
    _onOverviewShowing() {
        const win = global.display.focus_window;
        if (win && win.get_window_type() === Meta.WindowType.NORMAL)
            this._overviewWindowId = win.get_id();

        this._dbg(`OVERVIEW show saveWinId=${this._overviewWindowId} force "${DEFAULT_IM}"`);
        this._setCurrentIM(DEFAULT_IM);
    }

    _onOverviewHiding() {
        const focusWin   = global.display.focus_window;
        const focusWinId = (focusWin && focusWin.get_window_type() === Meta.WindowType.NORMAL)
                           ? focusWin.get_id() : null;

        // If the user switched to a different window while overview was open,
        // _onFocusWindowChanged already handled the restore for the new window.
        // Skip here to avoid cancelling that debounce with a stale target.
        if (focusWinId !== null && focusWinId !== this._overviewWindowId) {
            this._dbg(`OVERVIEW hide SKIP (focus changed: ${this._overviewWindowId} -> ${focusWinId})`);
            this._overviewWindowId = null;
            return;
        }

        const restore = (this._overviewWindowId !== null &&
                         this._stateMap.has(this._overviewWindowId))
                        ? this._stateMap.get(this._overviewWindowId) : null;
        this._dbg(`OVERVIEW hide prevWinId=${this._overviewWindowId} restore="${restore}"`);
        if (this._overviewWindowId !== null &&
            this._stateMap.has(this._overviewWindowId)) {
            this._setCurrentIM(this._stateMap.get(this._overviewWindowId));
        }
        this._overviewWindowId = null;
    }

    _isLauncher(wmClass) {
        return LAUNCHER_BLACKLIST.some(l => wmClass.includes(l));
    }

    // ======================================================================
    //  Memory Leak Prevention: window lifecycle tracking
    // ======================================================================
    _trackWindow(win) {
        if (this._windowSignalMap.has(win))
            return;

        const winId = win.get_id();
        const unmanagedId = win.connect('unmanaged', () => {
            this._dbg(`UNMANAGED win=${winId} (delete from stateMap)`);
            this._stateMap.delete(win.get_id());
            this._windowSignalMap.delete(win);
        });

        this._windowSignalMap.set(win, [unmanagedId]);
        this._dbg(`TRACK win=${winId} (trackedWindows=${this._windowSignalMap.size})`);
    }

    // ======================================================================
    //  D-Bus helper with debounce (Race Condition Prevention)
    // ======================================================================
    _setCurrentIM(imName) {
        if (!this._proxy)
            return;

        const im          = String(imName);
        const hadPending  = this._debounceSource !== 0;
        this._pendingIm   = im;

        if (this._debounceSource)
            GLib.source_remove(this._debounceSource);

        this._dbg(`setIM SCHEDULE "${im}"${hadPending ? ' (cancelled previous)' : ''} debounce=${DEBOUNCE_MS}ms`);

        this._debounceSource = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            DEBOUNCE_MS,
            () => {
                this._debounceSource = 0;
                if (!this._proxy || !this._pendingIm) {
                    this._dbg(`setIM FIRE SKIP: proxy=${!!this._proxy} pending="${this._pendingIm}"`);
                    return GLib.SOURCE_REMOVE;
                }

                const target = this._pendingIm;
                this._pendingIm = null;

                this._dbg(`setIM FIRE "${target}" (inProgrammaticSwitch=true)`);
                this._inProgrammaticSwitch = true;
                this._proxy.SetCurrentIMRemote(target, (result, error) => {
                    if (error) {
                        this._dbg(`setIM FAIL "${target}": ${error.message}`);
                        log(`[fcitx5-window-state] SetCurrentIM failed: ${error.message}`);
                    } else {
                        this._lastKnownIM = target;
                        this._dbg(`setIM OK "${target}" lastKnownIM="${this._lastKnownIM}"`);
                    }
                    this._inProgrammaticSwitch = false;
                });

                return GLib.SOURCE_REMOVE;
            }
        );
    }
}
