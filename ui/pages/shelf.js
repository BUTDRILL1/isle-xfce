// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

//! Shelf & Clipboard page for Isle XFCE GTK4 runtime.
//! Combines Shelf dropped files and Clipboard history into a unified dual-mode view.

import Gdk from 'gi://Gdk?version=4.0';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk?version=4.0';
import Pango from 'gi://Pango';

import * as Format from '../format.js';
import { icon, iconButton, label, pillButton } from '../widgets.js';
import { Page } from '../page.js';

export const ShelfPage = GObject.registerClass({
    GTypeName: 'IsleGtkShelfPage',
}, class ShelfPage extends Page {
    _init(daemon, { height = 150 } = {}) {
        super._init(daemon, {
            name: 'shelf',
            height,
            available: true,
        });

        this._mode = 'shelf'; // 'shelf' | 'clips'
        this._shelfItems = [];
        this._clipItems = [];

        this._buildUi();
        this._setupDropTarget();

        this.watch(['shelf', 'clipboard'], () => this._update());
        this._update();
    }

    get available() {
        return true;
    }

    _buildUi() {
        this._header = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 8,
            hexpand: true,
            css_classes: ['isle-shelf-bar'],
        });

        // Mode Switcher (Shelf | Clips)
        const switcher = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 2,
            css_classes: ['isle-segmented'],
        });

        this._shelfBtn = new Gtk.Button({
            label: 'Shelf',
            css_classes: ['isle-segment', 'is-active'],
            can_focus: true,
        });
        this._shelfBtn.connect('clicked', () => this._setMode('shelf'));

        this._clipsBtn = new Gtk.Button({
            label: 'Clips',
            css_classes: ['isle-segment'],
            can_focus: true,
        });
        this._clipsBtn.connect('clicked', () => this._setMode('clips'));

        switcher.append(this._shelfBtn);
        switcher.append(this._clipsBtn);
        this._header.append(switcher);

        // Spacer
        const spacer = new Gtk.Box({ hexpand: true });
        this._header.append(spacer);

        // Shelf Mode Actions
        this._shelfActions = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 6,
        });
        const addBtn = pillButton('+ Add file', 'isle-pill', () => this._onAddFile());
        const clearShelfBtn = pillButton('Clear', 'isle-pill', () => this.daemon.call('shelf', 'Clear'));
        this._shelfActions.append(addBtn);
        this._shelfActions.append(clearShelfBtn);
        this._header.append(this._shelfActions);

        // Clips Mode Actions
        this._clipsActions = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 6,
            visible: false,
        });
        const clearClipsBtn = pillButton('Clear all', 'isle-pill', () => this.daemon.call('clipboard', 'Clear'));
        this._clipsActions.append(clearClipsBtn);
        this._header.append(this._clipsActions);

        this.append(this._header);

        // Dynamic content box
        this._contentBox = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            hexpand: true,
            vexpand: true,
            css_classes: ['isle-shelf-content'],
        });
        this.append(this._contentBox);
    }

    _setMode(mode) {
        if (this._mode === mode) return;
        this._mode = mode;

        if (mode === 'shelf') {
            this._shelfBtn.add_css_class('is-active');
            this._clipsBtn.remove_css_class('is-active');
            this._shelfActions.set_visible(true);
            this._clipsActions.set_visible(false);
        } else {
            this._shelfBtn.remove_css_class('is-active');
            this._clipsBtn.add_css_class('is-active');
            this._shelfActions.set_visible(false);
            this._clipsActions.set_visible(true);
        }

        this._renderContent();
    }

    _setupDropTarget() {
        try {
            const dropTarget = Gtk.DropTarget.new(Gdk.FileList, Gdk.DragAction.COPY);
            dropTarget.connect('drop', (_target, value) => {
                if (!value) return false;
                let uris = [];
                if (value instanceof Gdk.FileList) {
                    uris = value.get_files().map(f => f.get_uri());
                }
                if (uris.length > 0) {
                    this.daemon.call('shelf', 'Add', uris);
                    return true;
                }
                return false;
            });
            this.add_controller(dropTarget);
        } catch (_e) {
            try {
                const dropTargetStr = Gtk.DropTarget.new(GObject.TYPE_STRING, Gdk.DragAction.COPY);
                dropTargetStr.connect('drop', (_target, value) => {
                    if (typeof value === 'string') {
                        const uris = value.split('\n')
                            .map(s => s.trim())
                            .filter(s => s.startsWith('file://'));
                        if (uris.length > 0) {
                            this.daemon.call('shelf', 'Add', uris);
                            return true;
                        }
                    }
                    return false;
                });
                this.add_controller(dropTargetStr);
            } catch (_err) {}
        }
    }

    _onAddFile() {
        try {
            const chooser = new Gtk.FileChooserNative({
                title: 'Add File to Shelf',
                action: Gtk.FileChooserAction.OPEN,
                modal: true,
            });
            chooser.connect('response', (dialog, response) => {
                if (response === Gtk.ResponseType.ACCEPT) {
                    const file = dialog.get_file();
                    if (file) {
                        this.daemon.call('shelf', 'Add', [file.get_uri()]);
                    }
                }
                dialog.destroy();
            });
            chooser.show();
        } catch (e) {
            console.warn('ShelfPage: file chooser error:', e.message);
        }
    }

    _update() {
        const rawShelf = this.daemon?.state?.shelf;
        this._shelfItems = Array.isArray(rawShelf)
            ? rawShelf
            : (rawShelf?.items ?? []);

        const rawClips = this.daemon?.state?.clipboard;
        this._clipItems = Array.isArray(rawClips)
            ? rawClips
            : (rawClips?.items ?? []);

        this._renderContent();
    }

    _clearContent() {
        let child = this._contentBox.get_first_child();
        while (child) {
            const next = child.get_next_sibling();
            this._contentBox.remove(child);
            child = next;
        }
    }

    _renderContent() {
        this._clearContent();
        if (this._mode === 'shelf') {
            this._renderShelf();
        } else {
            this._renderClips();
        }
    }

    _renderShelf() {
        if (this._shelfItems.length === 0) {
            const empty = this._buildEmpty({
                iconName: 'isle-file',
                iconSize: 28,
                title: 'Shelf is empty',
                hint: 'Drag files here or click + Add file',
            });
            this._contentBox.append(empty);
            return;
        }

        const scroll = new Gtk.ScrolledWindow({
            hscrollbar_policy: Gtk.PolicyType.AUTOMATIC,
            vscrollbar_policy: Gtk.PolicyType.NEVER,
            hexpand: true,
            vexpand: true,
            css_classes: ['isle-shelf-files'],
        });

        const row = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 12,
            halign: Gtk.Align.START,
            valign: Gtk.Align.CENTER,
            css_classes: ['isle-shelf-tiles'],
        });

        for (const item of this._shelfItems) {
            row.append(this._buildShelfTile(item));
        }

        scroll.set_child(row);
        this._contentBox.append(scroll);
    }

    _buildShelfTile(item) {
        const tile = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 6,
            valign: Gtk.Align.CENTER,
            halign: Gtk.Align.CENTER,
            css_classes: ['isle-shelf-tile'],
        });
        tile.set_size_request(96, 110);

        // Header with remove button
        const head = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            halign: Gtk.Align.END,
        });
        const removeBtn = iconButton('isle-close-symbolic', 'isle-shelf-remove isle-button-flat', () => {
            this.daemon.call('shelf', 'Remove', item.uri);
        }, { size: 10, accessibleName: 'Remove from shelf' });
        head.append(removeBtn);
        tile.append(head);

        // File icon
        const img = new Gtk.Image({
            gicon: icon('isle-file'),
            pixel_size: 36,
            halign: Gtk.Align.CENTER,
            valign: Gtk.Align.CENTER,
            css_classes: ['isle-shelf-preview'],
        });
        tile.append(img);

        // Name
        const nameText = item.name || GLib.path_get_basename(item.uri.replace(/^file:\/\//, '')) || 'File';
        const nameLbl = label(nameText, 'isle-shelf-name');
        nameLbl.set_ellipsize(Pango.EllipsizeMode.END);
        nameLbl.set_lines(2);
        nameLbl.set_wrap(true);
        nameLbl.set_halign(Gtk.Align.CENTER);
        tile.append(nameLbl);

        // Click to launch/open file
        const click = new Gtk.GestureClick();
        click.connect('released', () => {
            try {
                Gio.AppInfo.launch_default_for_uri(item.uri, null);
            } catch (e) {
                console.warn('ShelfPage: could not open file:', e.message);
            }
        });
        tile.add_controller(click);

        return tile;
    }

    _renderClips() {
        if (this._clipItems.length === 0) {
            const empty = this._buildEmpty({
                iconName: 'isle-clipboard',
                iconSize: 28,
                title: 'Clipboard is empty',
                hint: 'Copied items will appear here',
            });
            this._contentBox.append(empty);
            return;
        }

        const scroll = new Gtk.ScrolledWindow({
            hscrollbar_policy: Gtk.PolicyType.AUTOMATIC,
            vscrollbar_policy: Gtk.PolicyType.NEVER,
            hexpand: true,
            vexpand: true,
            css_classes: ['isle-clips-scroll'],
        });

        const row = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 10,
            halign: Gtk.Align.START,
            valign: Gtk.Align.CENTER,
            css_classes: ['isle-clips'],
        });

        for (const item of this._clipItems) {
            row.append(this._buildClipCard(item));
        }

        scroll.set_child(row);
        this._contentBox.append(scroll);
    }

    _buildClipCard(item) {
        const card = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 6,
            valign: Gtk.Align.FILL,
            css_classes: ['isle-clip'],
        });
        card.set_size_request(140, 110);

        // Card header (type icon, pin button, remove button)
        const head = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 4,
            css_classes: ['isle-clip-header'],
        });

        const kindIconName = {
            link: 'isle-link',
            image: 'isle-image',
            files: 'isle-file',
            text: 'isle-text',
        }[item.kind] ?? 'isle-text';

        const kindImg = new Gtk.Image({
            gicon: icon(kindIconName),
            pixel_size: 14,
            halign: Gtk.Align.START,
        });
        head.append(kindImg);

        const spacer = new Gtk.Box({ hexpand: true });
        head.append(spacer);

        // Pin button
        const pinIcon = item.pinned ? 'isle-pin-fill' : 'isle-pin';
        const pinBtn = iconButton(pinIcon, 'isle-button-flat isle-clip-action', () => {
            this.daemon.call('clipboard', 'SetPinned', item.id, !item.pinned);
        }, { size: 12, accessibleName: item.pinned ? 'Unpin' : 'Pin' });
        head.append(pinBtn);

        // Remove button
        const removeBtn = iconButton('isle-close-symbolic', 'isle-button-flat isle-clip-action', () => {
            this.daemon.call('clipboard', 'Remove', item.id);
        }, { size: 10, accessibleName: 'Remove from history' });
        head.append(removeBtn);

        card.append(head);

        // Preview body
        const previewLbl = label(item.preview || '', 'isle-clip-text');
        previewLbl.set_wrap(true);
        previewLbl.set_lines(3);
        previewLbl.set_ellipsize(Pango.EllipsizeMode.END);
        previewLbl.set_halign(Gtk.Align.START);
        previewLbl.set_valign(Gtk.Align.START);
        previewLbl.set_hexpand(true);
        previewLbl.set_vexpand(true);
        card.append(previewLbl);

        // Click to copy to clipboard & select in daemon
        const click = new Gtk.GestureClick();
        click.connect('released', () => {
            try {
                const clip = Gdk.Display.get_default().get_clipboard();
                clip.set(item.preview || '');
                this.daemon.call('clipboard', 'Select', item.id);
                this.daemon.call('clipboard', 'Touch', item.id);

                const prev = previewLbl.get_text();
                previewLbl.set_text('✓ Copied');
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 800, () => {
                    previewLbl.set_text(prev);
                    return GLib.SOURCE_REMOVE;
                });
            } catch (e) {
                console.warn('ShelfPage: copy error:', e.message);
            }
        });
        card.add_controller(click);

        return card;
    }
});
