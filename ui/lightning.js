// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

//! Cairo-rendered rising lightning bolts & animated border overlay for Lightning + AC mode.

import Cairo from 'cairo';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk?version=4.0';

import { getPowerProfile, getTelemetryMonitor, isAcPluggedIn } from './telemetry.js';

const BOLT_COUNT = 12;

function roundedRectPath(cr, x, y, w, h, r) {
    const rad = Math.min(r, w / 2, h / 2);
    cr.newSubPath();
    cr.arc(x + w - rad, y + rad, rad, -Math.PI / 2, 0);
    cr.arc(x + w - rad, y + h - rad, rad, 0, Math.PI / 2);
    cr.arc(x + rad, y + h - rad, rad, Math.PI / 2, Math.PI);
    cr.arc(x + rad, y + rad, rad, Math.PI, 1.5 * Math.PI);
    cr.closePath();
}

export const LightningOverlay = GObject.registerClass({
    GTypeName: 'IsleGtkLightningOverlay',
}, class LightningOverlay extends Gtk.DrawingArea {
    _init() {
        super._init({
            hexpand: true,
            vexpand: true,
            can_target: false,
            sensitive: false,
            visible: false,
        });

        this._active = false;
        this._expanded = false;
        this._timerId = 0;
        this._phase = 0;
        this._bolts = Array.from({ length: BOLT_COUNT }, (_, i) => this._newBolt(i / BOLT_COUNT));

        this.set_draw_func((_area, cr, w, h) => this._draw(cr, w, h));

        const monitor = getTelemetryMonitor();
        monitor.connect('power-changed', () => this.refresh());
        monitor.connect('updated', () => this.refresh());
        this.refresh();
    }

    _newBolt(initialProgress = 0) {
        return {
            xNorm: 0.06 + Math.random() * 0.88,
            progress: initialProgress,
            speed: 0.012 + Math.random() * 0.016,
            size: 6 + Math.random() * 6,
            swayAmp: 1.5 + Math.random() * 3.0,
            swayFreq: 2.0 + Math.random() * 3.0,
            isBolt: Math.random() > 0.3,
            alpha: 0.55 + Math.random() * 0.45,
        };
    }

    setExpanded(expanded) {
        const next = Boolean(expanded);
        if (this._expanded === next) return;
        this._expanded = next;
        this.refresh();
    }

    refresh() {
        const shouldRun = this._expanded && isAcPluggedIn() && getPowerProfile() === 'lightning';
        if (shouldRun === this._active) return;
        this._active = shouldRun;

        if (shouldRun) {
            this.set_visible(true);
            if (!this._timerId) {
                this._timerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 33, () => {
                    if (!this._active) {
                        this._timerId = 0;
                        return GLib.SOURCE_REMOVE;
                    }
                    this._step();
                    this.queue_draw();
                    return GLib.SOURCE_CONTINUE;
                });
            }
        } else {
            if (this._timerId) {
                GLib.source_remove(this._timerId);
                this._timerId = 0;
            }
            this.set_visible(false);
        }
    }

    _step() {
        this._phase = (this._phase + 0.045) % (Math.PI * 2);
        for (let i = 0; i < this._bolts.length; i++) {
            const b = this._bolts[i];
            b.progress += b.speed;
            if (b.progress >= 1.0) {
                this._bolts[i] = this._newBolt(0);
            }
        }
    }

    _draw(cr, w, h) {
        if (!this._active || w <= 4 || h <= 4) return;

        const isCompact = h <= 56;
        const radius = isCompact ? h / 2 : 22;

        // Clip interior rising bolts to the pill shape
        cr.save();
        roundedRectPath(cr, 1, 1, w - 2, h - 2, radius);
        cr.clip();

        // Subtle bottom purple energy mist
        const mist = new Cairo.LinearGradient(0, h, 0, h * 0.45);
        mist.addColorStopRGBA(0, 0.75, 0.35, 0.95, 0.22);
        mist.addColorStopRGBA(1, 0.75, 0.35, 0.95, 0.0);
        cr.setSource(mist);
        cr.paint();

        // Draw rising mini lightning bolts & sparks from bottom to top
        for (const b of this._bolts) {
            const fadeIn = Math.min(1, b.progress * 5);
            const fadeOut = Math.max(0, 1 - Math.pow(b.progress, 1.8));
            const alpha = b.alpha * fadeIn * fadeOut;
            if (alpha <= 0.02) continue;

            const x = b.xNorm * w + Math.sin(b.progress * b.swayFreq * Math.PI) * b.swayAmp;
            const y = h - b.progress * (h + 6);

            if (b.isBolt) {
                const s = b.size;
                // Outer violet glow
                cr.setLineCap(Cairo.LineCap.ROUND);
                cr.setLineJoin(Cairo.LineJoin.ROUND);
                cr.setSourceRGBA(0.75, 0.35, 0.95, alpha * 0.45);
                cr.setLineWidth(3.2);
                cr.moveTo(x + s * 0.15, y - s * 0.55);
                cr.lineTo(x - s * 0.22, y - s * 0.02);
                cr.lineTo(x + s * 0.14, y + s * 0.04);
                cr.lineTo(x - s * 0.16, y + s * 0.55);
                cr.stroke();

                // Bright white-lavender core
                cr.setSourceRGBA(0.95, 0.85, 1.0, alpha * 0.95);
                cr.setLineWidth(1.3);
                cr.moveTo(x + s * 0.15, y - s * 0.55);
                cr.lineTo(x - s * 0.22, y - s * 0.02);
                cr.lineTo(x + s * 0.14, y + s * 0.04);
                cr.lineTo(x - s * 0.16, y + s * 0.55);
                cr.stroke();
            } else {
                // Glowing spark dot
                cr.setSourceRGBA(0.85, 0.55, 1.0, alpha);
                cr.arc(x, y, 1.4, 0, Math.PI * 2);
                cr.fill();
            }
        }
        cr.restore();

        // Animated sweeping border around the notch perimeter
        const sweepX = w * 0.5 + Math.cos(this._phase) * (w * 0.65);
        const sweepY = h * 0.5 + Math.sin(this._phase) * (h * 0.65);
        const borderGrad = new Cairo.RadialGradient(sweepX, sweepY, 4, sweepX, sweepY, Math.max(w, h) * 0.55);
        borderGrad.addColorStopRGBA(0, 0.92, 0.72, 1.0, 0.95);
        borderGrad.addColorStopRGBA(0.45, 0.75, 0.35, 0.95, 0.75);
        borderGrad.addColorStopRGBA(1, 0.55, 0.25, 0.85, 0.22);

        cr.save();
        roundedRectPath(cr, 1.5, 1.5, w - 3, h - 3, radius);
        cr.setSource(borderGrad);
        cr.setLineWidth(2.0);
        cr.stroke();
        cr.restore();
    }

    destroy() {
        if (this._timerId) {
            GLib.source_remove(this._timerId);
            this._timerId = 0;
        }
    }
});

